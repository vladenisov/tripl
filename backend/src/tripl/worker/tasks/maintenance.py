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

logger = logging.getLogger(__name__)

# A delivery still `pending` this long after creation was almost certainly
# never dispatched (a real send completes in seconds). Comfortably above any
# normal send latency so we don't race a delivery that's actively in flight.
STRANDED_DELIVERY_MINUTES = 15
# Cap re-enqueues so a delivery that keeps failing to dispatch (e.g. a
# permanently unreachable broker target) is eventually marked failed instead
# of being requeued forever.
MAX_DISPATCH_ATTEMPTS = 5


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
    """Re-enqueue alert deliveries stuck in `pending` past the stranded horizon.

    A delivery that is still pending well after creation was never picked up
    by ``send_alert_delivery`` (the worker died between the outer commit and
    dispatch, or the broker was down when ``.delay()`` was called). We bump a
    per-delivery attempt counter and re-enqueue; once attempts are exhausted
    the delivery is marked failed so it stops cycling.
    """
    # Deferred import to avoid a circular import at module load: alerts ->
    # celery_app -> (beat registers tasks) and maintenance both import the app.
    from tripl.worker.tasks.alerts import send_alert_delivery

    cutoff = datetime.now(UTC) - timedelta(minutes=STRANDED_DELIVERY_MINUTES)
    session = _get_sync_session()
    requeued: list[str] = []
    exhausted: list[str] = []
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

        # Persist the attempt-counter bumps and any failed transitions before
        # enqueueing, so a crash mid-loop can't re-enqueue without recording it.
        session.commit()

        for delivery_id in to_dispatch:
            send_alert_delivery.delay(delivery_id)
            requeued.append(delivery_id)

        logger.info(
            "Reaper: re-enqueued %d stranded alert deliveries, marked %d exhausted "
            "(older than %s)",
            len(requeued),
            len(exhausted),
            cutoff.isoformat(),
        )
        return {
            "requeued": len(requeued),
            "exhausted": len(exhausted),
            "cutoff": cutoff.isoformat(),
        }
    finally:
        session.close()
