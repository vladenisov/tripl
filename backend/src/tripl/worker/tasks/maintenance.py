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
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select

from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.schema_drift import SchemaDrift
from tripl.services.schema_drift_service import DRIFT_RETENTION_DAYS
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _get_sync_session
from tripl.worker.tasks._errors import is_transient_send_error

logger = logging.getLogger(__name__)

# A delivery still `pending` this long after it was created AND last touched
# was almost certainly never dispatched (a real send completes in seconds).
# Comfortably above any normal send latency so we don't race a delivery that's
# actively in flight — which is why the query below also checks ``updated_at``:
# a manual Retry or the failed arm's auto-retry flips an OLD row back to
# pending, and measuring only from creation would let this arm re-enqueue it
# on the very next tick, racing the send those paths just dispatched.
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
    (``is_transient_send_error`` over the persisted ``error_message``) is sent
    back to `pending` — keeping its error text — and re-enqueued within the
    same attempt budget. Ticket channels (Jira/Linear) and disabled
    destinations are never auto-retried. Pacing: this task runs on a 5-minute
    beat (see ``celery_app.beat_schedule``), each failure refreshes
    ``updated_at``, and the pending flip makes every requeue single-flight —
    a blip is retried up to ``MAX_DISPATCH_ATTEMPTS`` times a few minutes
    apart, then left failed for the manual Retry button, which resets the
    budget.
    """
    # Deferred import to avoid a circular import at module load: alerts ->
    # celery_app -> (beat registers tasks) and maintenance both import the app.
    from tripl.worker.tasks.alert_digest_send import COMBINABLE_CHANNELS, send_alert_digest
    from tripl.worker.tasks.alerts import send_alert_delivery

    cutoff = datetime.now(UTC) - timedelta(minutes=STRANDED_DELIVERY_MINUTES)
    retry_cutoff = datetime.now(UTC) - AUTO_RETRY_FAILED_HORIZON
    session = _get_sync_session()
    requeued: list[str] = []
    exhausted: list[str] = []
    auto_retried: list[str] = []
    try:
        # No ``AlertDestination.enabled`` join here, deliberately, and the
        # asymmetry with the failed arm below is load-bearing rather than an
        # oversight to tidy up. A disabled destination must not be sent to
        # (tripl-0zpq.39) — but that is enforced in the send task, by
        # ``alerts._assert_destination_enabled``, which turns this redispatch
        # into a `failed` row naming the toggle: visible in the Inbox, where an
        # alert that did not go out belongs. Filtering it out HERE instead
        # would leave such a row selected by nothing at all — never
        # redispatched, never reaching the exhaustion relabel below — sitting
        # at `pending` for good. The failed arm can filter precisely because
        # every row it skips is already in a terminal state the operator sees.
        stranded = (
            session.execute(
                select(AlertDelivery).where(
                    AlertDelivery.status == AlertDeliveryStatus.pending.value,
                    AlertDelivery.created_at < cutoff,
                    AlertDelivery.updated_at < cutoff,
                )
            )
            .scalars()
            .all()
        )

        to_dispatch: list[str] = []
        for delivery in stranded:
            if delivery.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS:
                delivery.status = AlertDeliveryStatus.failed.value
                # Only when nothing better is known: a row the failed arm
                # below sent back to pending carries its real send error, and
                # relabeling it "stranded" would erase the actual cause.
                if delivery.error_message is None:
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
                select(AlertDelivery)
                .join(AlertDestination, AlertDelivery.destination_id == AlertDestination.id)
                .where(
                    AlertDelivery.status == AlertDeliveryStatus.failed.value,
                    AlertDelivery.updated_at >= retry_cutoff,
                    AlertDelivery.dispatch_attempts < MAX_DISPATCH_ATTEMPTS,
                    # Ticket channels are excluded: a Jira/Linear create is not
                    # idempotent, and a timeout AFTER the tracker accepted the
                    # request leaves no external id in the snapshot, so an
                    # automatic re-run would mint a duplicate ticket per
                    # attempt. A human pressing Retry can check the tracker
                    # first; this arm cannot.
                    AlertDelivery.channel.notin_(
                        (
                            AlertDestinationType.jira.value,
                            AlertDestinationType.linear.value,
                        )
                    ),
                    # A destination the operator disabled mid-incident stays
                    # silent: auto-retrying rows they watched fail and then
                    # switched off would re-send through a toggle that says off.
                    AlertDestination.enabled.is_(True),
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
            # Flipped to `pending` so exactly one arm owns the row at a time:
            # a row this tick enqueued no longer matches this arm's WHERE on
            # the next tick (single-flight), and the manual Retry endpoint —
            # which accepts only `failed` rows — 409s while an automatic
            # attempt is queued, closing the operator-vs-reaper double-send
            # race. If the enqueue below is lost, the stranded arm above is
            # the backstop, exactly as it is for a manual retry. The error
            # text is deliberately KEPT (the manual path clears it): until the
            # queued attempt resolves, the last failure is still the truest
            # thing known about this row, and the exhaustion relabel above
            # now leaves an existing message alone.
            delivery.status = AlertDeliveryStatus.pending.value
            delivery.dispatch_attempts += 1
            # This row is going back to a send task, so it has to be claimable
            # when it gets there (``alerts._claim_delivery``). Both send tasks
            # release their own lease when an attempt ends, so a `failed` row
            # should already carry none; clearing it here makes the hand-off
            # unconditional rather than dependent on that release having run,
            # and it is always safe because a live attempt holds its row at
            # `pending` — never at `failed`.
            delivery.claimed_at = None
            to_auto_retry.append(str(delivery.id))

        # Persist both arms' attempt-counter bumps and any failed transitions
        # before enqueueing, so a crash mid-loop can't re-enqueue without
        # recording it.
        session.commit()

        # Rows minted by one digest flush share destination and transaction
        # timestamp. Keep stranded members together rather than flattening
        # each one into an immediate alert. A lone surviving member still goes
        # through the digest sender and retains its digest layout.
        queued = [*to_dispatch, *to_auto_retry]
        queued_rows = {str(row.id): row for row in [*stranded, *recent_failed]}
        digest_groups: dict[tuple[uuid.UUID, datetime], list[str]] = {}
        combinable_destinations = {
            destination_id
            for destination_id, destination_type in session.execute(
                select(AlertDestination.id, AlertDestination.type).where(
                    AlertDestination.id.in_({row.destination_id for row in queued_rows.values()})
                )
            )
            if destination_type in COMBINABLE_CHANNELS
        }
        for delivery_id in queued:
            row = queued_rows[delivery_id]
            snapshot = row.payload_snapshot
            if (
                row.destination_id in combinable_destinations
                and isinstance(snapshot, dict)
                and snapshot.get("digest")
            ):
                digest_groups.setdefault((row.destination_id, row.created_at), []).append(
                    delivery_id
                )
            else:
                send_alert_delivery.delay(delivery_id)
        for delivery_ids in digest_groups.values():
            send_alert_digest.delay(delivery_ids)

        for delivery_id in to_dispatch:
            requeued.append(delivery_id)

        for delivery_id in to_auto_retry:
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
