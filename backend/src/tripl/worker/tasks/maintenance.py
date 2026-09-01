"""Periodic housekeeping for storage-bound tables.

- prune SchemaDrift rows past their retention horizon. The drift table only
  re-upserts rows that still represent live drift, so anything older than
  DRIFT_RETENTION_DAYS no longer corresponds to anything the catalog should
  surface.
- re-enqueue AlertDelivery rows stranded in `pending`. Deliveries are
  committed as pending and dispatched via ``send_alert_delivery.delay()``
  after the outer commit; if the worker crashes between commit and dispatch,
  or ``.delay()`` raises against a down broker, those rows are never sent and
  never retried. The reaper picks them up.
- auto-retry AlertDelivery rows that recently `failed` on a transient network
  error. A send that dies on an egress blip ("[Errno 101] Network is
  unreachable" while 98 of the previous 100 deliveries sent — caught live
  2026-08-31) was otherwise lost until a human clicked Retry; the reaper
  re-enqueues such rows within the same dispatch-attempts budget.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select

from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.schema_drift import SchemaDrift
from tripl.services.schema_drift_service import DRIFT_RETENTION_DAYS
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _get_sync_session
from tripl.worker.tasks._errors import is_transient_send_error

logger = logging.getLogger(__name__)

# A delivery still `pending` this long after creation was almost certainly
# never dispatched (a real send completes in seconds). Comfortably above any
# normal send latency so we don't race a delivery that's actively in flight.
STRANDED_DELIVERY_MINUTES = 15
# Cap re-enqueues so a delivery that keeps failing to dispatch (e.g. a
# permanently unreachable broker target) is eventually marked failed instead
# of being requeued forever.
MAX_DISPATCH_ATTEMPTS = 5
# Auto-retry (the failed arm of the reaper) exists for blips: a delivery that
# failed on a transient network error moments ago will very likely succeed on
# the next attempt. Failures older than this belong to the human and the
# manual Retry button — and the horizon is also what stops the reaper from
# resurrecting ancient transient failures en masse on deploy.
AUTO_RETRY_FAILED_HORIZON = timedelta(hours=6)


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.maintenance.cleanup_schema_drifts",
)
def cleanup_schema_drifts() -> dict[str, object]:
    cutoff = datetime.now(UTC) - timedelta(days=DRIFT_RETENTION_DAYS)
    session = _get_sync_session()
    try:
        result = session.execute(delete(SchemaDrift).where(SchemaDrift.detected_at < cutoff))
        session.commit()
        deleted = int(getattr(result, "rowcount", 0) or 0)
        logger.info("Pruned %d schema_drifts rows older than %s", deleted, cutoff.isoformat())
        return {"deleted": deleted, "cutoff": cutoff.isoformat()}
    finally:
        session.close()


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.maintenance.requeue_stranded_alert_deliveries",
)
def requeue_stranded_alert_deliveries() -> dict[str, object]:
    """Re-enqueue stranded `pending` deliveries and auto-retry transient `failed` ones.

    Pending arm: a delivery that is still pending well after creation was
    never picked up by ``send_alert_delivery`` (the worker died between the
    outer commit and dispatch, or the broker was down when ``.delay()`` was
    called). We bump a per-delivery attempt counter and re-enqueue; once
    attempts are exhausted the delivery is marked failed so it stops cycling.

    Failed arm: a delivery that recently failed on a transient network error
    (``is_transient_send_error`` over the persisted ``error_message``) is
    re-enqueued within the same attempt budget, with its status and error
    left in place. Pacing: this task runs on a 5-minute beat (see
    ``celery_app.beat_schedule``) and every attempt refreshes ``updated_at``,
    so a delivery gets roughly one retry per tick — a blip is retried up to
    ``MAX_DISPATCH_ATTEMPTS`` times about 5 minutes apart, then left failed
    for the manual Retry button.
    """
    # Deferred import to avoid a circular import at module load: alerts ->
    # celery_app -> (beat registers tasks) and maintenance both import the app.
    from tripl.worker.tasks.alerts import send_alert_delivery

    cutoff = datetime.now(UTC) - timedelta(minutes=STRANDED_DELIVERY_MINUTES)
    retry_cutoff = datetime.now(UTC) - AUTO_RETRY_FAILED_HORIZON
    session = _get_sync_session()
    requeued: list[str] = []
    exhausted: list[str] = []
    auto_retried: list[str] = []
    try:
        stranded = (
            session.execute(
                select(AlertDelivery).where(
                    AlertDelivery.status == AlertDeliveryStatus.pending.value,
                    AlertDelivery.created_at < cutoff,
                )
            )
            .scalars()
            .all()
        )

        to_dispatch: list[str] = []
        for delivery in stranded:
            if delivery.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS:
                delivery.status = AlertDeliveryStatus.failed.value
                delivery.error_message = (
                    f"Stranded in pending: exhausted {MAX_DISPATCH_ATTEMPTS} "
                    "redispatch attempts without delivery."
                )
                exhausted.append(str(delivery.id))
                continue
            delivery.dispatch_attempts += 1
            to_dispatch.append(str(delivery.id))

        recent_failed = (
            session.execute(
                select(AlertDelivery).where(
                    AlertDelivery.status == AlertDeliveryStatus.failed.value,
                    AlertDelivery.updated_at >= retry_cutoff,
                    AlertDelivery.dispatch_attempts < MAX_DISPATCH_ATTEMPTS,
                )
            )
            .scalars()
            .all()
        )
        to_auto_retry: list[str] = []
        for delivery in recent_failed:
            # ``is_transient_send_error`` matches over the persisted error text
            # in Python, so this filter cannot live in the WHERE clause above.
            if not is_transient_send_error(delivery.error_message):
                continue
            # Status stays `failed` and ``error_message`` is kept: the row
            # stays honest about its last failure between attempts, and
            # ``send_alert_delivery`` only short-circuits on `sent`, so it
            # processes a failed row and flips it to sent on success. The
            # manual Retry flips to `pending` instead — it resets the budget
            # and *wants* the pending reaper as its backstop. This arm IS the
            # reaper; a pending flip would hand the row to the stranded arm
            # above, whose exhaustion message would then lie about the cause.
            delivery.dispatch_attempts += 1
            to_auto_retry.append(str(delivery.id))

        # Persist both arms' attempt-counter bumps and any failed transitions
        # before enqueueing, so a crash mid-loop can't re-enqueue without
        # recording it.
        session.commit()

        for delivery_id in to_dispatch:
            send_alert_delivery.delay(delivery_id)
            requeued.append(delivery_id)

        for delivery_id in to_auto_retry:
            send_alert_delivery.delay(delivery_id)
            auto_retried.append(delivery_id)

        logger.info(
            "Reaper: re-enqueued %d stranded alert deliveries, marked %d exhausted "
            "(older than %s), auto-retried %d transient failures",
            len(requeued),
            len(exhausted),
            cutoff.isoformat(),
            len(auto_retried),
        )
        return {
            "requeued": len(requeued),
            "exhausted": len(exhausted),
            "auto_retried": len(auto_retried),
            "cutoff": cutoff.isoformat(),
        }
    finally:
        session.close()
