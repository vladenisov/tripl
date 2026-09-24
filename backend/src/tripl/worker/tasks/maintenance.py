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
- delete photo blobs no ``event_photos`` row references. Inline deletion alone
  leaks them: an event, project or branch delete removes photo rows by FK
  cascade without a storage call, and two concurrent ``delete_photo`` calls can
  each see the other's row and both keep the blob (tripl-0zpq.291).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select

from tripl.config import settings
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event_photo import EventPhoto
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.schema_drift import SchemaDrift
from tripl.services.event_photo_service import PHOTO_KEY_PREFIX
from tripl.services.schema_drift_service import DRIFT_RETENTION_DAYS
from tripl.storage import storage_for
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
    name="tripl.worker.tasks.maintenance.cleanup_scan_jobs",
)
def cleanup_scan_jobs() -> dict[str, object]:
    """Prune old terminal scan history while preserving every active job."""
    cutoff = datetime.now(UTC) - timedelta(days=settings.scan_job_retention_days)
    session = _get_sync_session()
    try:
        result = session.execute(
            delete(ScanJob).where(
                # A scan may run across the retention boundary. Prefer its
                # completion time; legacy rows lacking it use the last update,
                # then creation only if both timestamps are absent.
                func.coalesce(ScanJob.completed_at, ScanJob.updated_at, ScanJob.created_at)
                < cutoff,
                ScanJob.status.in_(
                    (
                        ScanJobStatus.completed.value,
                        ScanJobStatus.failed.value,
                        ScanJobStatus.cancelled.value,
                    )
                ),
            )
        )
        session.commit()
        deleted = int(getattr(result, "rowcount", 0) or 0)
        logger.info("Pruned %d scan_jobs rows older than %s", deleted, cutoff.isoformat())
        return {"deleted": deleted, "cutoff": cutoff.isoformat()}
    finally:
        session.close()


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.maintenance.cleanup_distribution_drifts",
)
def cleanup_distribution_drifts() -> dict[str, object]:
    """Keep significant drift longer than stable and minor observations."""
    now = datetime.now(UTC)
    significant_cutoff = now - timedelta(days=settings.distribution_drift_retention_days)
    minor_cutoff = now - timedelta(days=settings.distribution_drift_minor_retention_days)
    session = _get_sync_session()
    try:
        significant = session.execute(
            delete(DistributionDrift).where(
                DistributionDrift.band == "significant",
                DistributionDrift.bucket < significant_cutoff,
            )
        )
        minor = session.execute(
            delete(DistributionDrift).where(
                DistributionDrift.band.in_(("stable", "minor")),
                DistributionDrift.bucket < minor_cutoff,
            )
        )
        session.commit()
        significant_deleted = int(getattr(significant, "rowcount", 0) or 0)
        minor_deleted = int(getattr(minor, "rowcount", 0) or 0)
        deleted = significant_deleted + minor_deleted
        logger.info("Pruned %d distribution_drifts rows", deleted)
        return {
            "deleted": deleted,
            "significant_deleted": significant_deleted,
            "minor_deleted": minor_deleted,
        }
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


def _photo_backends_to_sweep() -> list[str]:
    """The photo backends this process can reach, whatever new uploads use.

    Rows written before a backend switch still point at the old store
    (tripl-0zpq.295), so its orphans are swept too. GCS only when a bucket is
    configured: without one the driver cannot even be built.
    """
    backends = ["local"]
    if settings.gcs_photo_bucket:
        backends.append("gcs")
    return backends


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.maintenance.sweep_orphan_photo_blobs",
)
def sweep_orphan_photo_blobs() -> dict[str, object]:
    """Delete photo blobs no ``event_photos`` row references, once they are old.

    Inline deletion cannot be the whole story (tripl-0zpq.291): deleting an
    event, a project or a branch removes photo rows by FK cascade and never
    calls storage, and two concurrent ``delete_photo`` calls on the last two
    rows holding one key each see the other and both keep the blob. This sweep
    is the backstop that makes every such leak temporary.

    The grace period covers uploads in flight: ``upload_photo`` writes the
    blob BEFORE it commits the row, and a blob younger than
    ``photo_orphan_sweep_grace_hours`` is never touched. Each candidate is also
    re-checked against the table right before it is deleted, so a row
    committed while the listing ran still keeps its blob.

    Known limit: the grace is measured from the blob's write time, not from its
    last reference. A branch creation copies ``storage_key`` onto new rows
    inside a transaction this session cannot see; if the last committed row
    holding an OLD key is deleted while that transaction is still open, the
    sweep sees no reference and may delete the blob the copy is about to
    commit. The window is the length of one ``create_branch`` transaction.

    Any row holding the key keeps it, in any project and on any branch — the
    same rule as ``event_photo_service._blob_is_referenced``. Only keys under
    ``PHOTO_KEY_PREFIX`` are considered, because the directory or bucket may
    hold objects tripl did not write. A backend without a listing API is
    skipped and logged.
    """
    cutoff = datetime.now(UTC) - timedelta(hours=settings.photo_orphan_sweep_grace_hours)
    session = _get_sync_session()
    deleted: list[str] = []
    skipped: list[str] = []
    try:
        for backend in _photo_backends_to_sweep():
            try:
                storage = storage_for(backend)
                listed = [
                    obj for obj in storage.list_objects(PHOTO_KEY_PREFIX) if obj.written_at < cutoff
                ]
            except Exception:
                logger.exception("Cannot list the %s photo backend; orphan sweep skips it", backend)
                skipped.append(backend)
                continue
            if not listed:
                continue
            referenced = set(
                session.execute(
                    select(EventPhoto.storage_key).where(
                        EventPhoto.storage_backend == backend,
                        EventPhoto.storage_key.is_not(None),
                    )
                )
                .scalars()
                .all()
            )
            if not referenced:
                # Old blobs on disk and not one row pointing at this backend is
                # what an empty or half-restored database looks like, not a set
                # of orphans. Deleting here would wipe every photo, so the sweep
                # refuses and says so; a real "no photos left" state costs only
                # the disk the leftovers use.
                logger.warning(
                    "Orphan photo sweep skipped %s: %d old blob(s) but no event_photos row "
                    "references this backend",
                    backend,
                    len(listed),
                )
                skipped.append(backend)
                continue
            for obj in listed:
                if obj.key in referenced:
                    continue
                # Re-read, not trusted from the set above: a row committed
                # since then — a branch copy, a merge — owns the blob now.
                still_referenced = session.scalar(
                    select(func.count())
                    .select_from(EventPhoto)
                    .where(
                        EventPhoto.storage_backend == backend,
                        EventPhoto.storage_key == obj.key,
                    )
                )
                if still_referenced:
                    continue
                try:
                    storage.delete_blocking(obj.key)
                except Exception:
                    logger.exception("Failed to delete orphan photo blob %s:%s", backend, obj.key)
                    continue
                deleted.append(f"{backend}:{obj.key}")
        logger.info("Swept %d orphan photo blob(s) older than %s", len(deleted), cutoff.isoformat())
        return {"deleted": deleted, "skipped_backends": skipped, "cutoff": cutoff.isoformat()}
    finally:
        session.close()
