"""Deliver held alerts on their destination's cadence.

A destination with ``delivery_schedule_cron`` set does not deliver after every
metrics collection. ``_prepare_alert_deliveries`` buffers its matched signals
into ``alert_pending_items`` instead, and this task turns the accumulated
buffer into ordinary ``AlertDelivery`` rows when a cron boundary passes.

The correctness argument, in one place, because it is the whole feature:

**Nothing is lost.** The buffered rows a flush ships are claimed by DELETING
them in the SAME transaction that mints the deliveries. There is no timestamp
predicate anywhere. That matters because ``created_at`` is
``server_default=func.now()`` — the INSERTing transaction's *start* clock — and
``collect_metrics`` builds buffer rows minutes before it commits. A row can
carry ``created_at = 09:00:01`` and only become visible at 09:00:20, so a flush
that selected ``created_at <= 09:00:10`` would neither see it nor ever see it
again once the next window's lower bound moved past. Claiming by row lifecycle
instead, a row that commits after the flush's snapshot is simply still
buffered, and lands in the next digest.

**Nothing is sent twice.** A row leaves the buffer exactly once, because the
DELETE and the delivery INSERT share a transaction: a rollback restores both,
a commit removes both. The window itself is claimed by a compare-and-set on
``last_flushed_at``, so a second tick — or a second worker — computing the same
fire instant gets ``rowcount == 0`` and does nothing.

**Everything up to the moment of sending.** The digest carries every scope that
had committed at the instant of the flush's snapshot, each with the numbers
from the most recent collection that committed by then, because the buffer is
an upsert keyed on the scope.

The advisory lock is a coarse guard against overlapping runs, deliberately NOT
the correctness argument: it is a no-op off Postgres, so the compare-and-set
and the row lifecycle have to hold on their own — and they do.
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from tripl.alerting_matching import AlertMatchCandidate, DriftAlertCandidate
from tripl.core.alert_schedule import previous_fire_at
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_pending_item import AlertPendingItem
from tripl.models.alert_rule import AlertRule
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _get_sync_session

# Everything from ``tripl.worker.tasks.metrics`` is imported INSIDE the
# functions below, never at module load. ``celery_app`` imports this module
# from its own bottom-of-file task registration, which can itself be reached
# from a partially-initialized ``tripl.worker.tasks.alerts`` — and a
# ``from tripl.worker.tasks.metrics.x import y`` at that moment resolves
# ``metrics/__init__``, which does ``from ...alerts import send_alert_delivery``
# against the half-built module and raises. ``maintenance.py`` defers its
# ``send_alert_delivery`` import for exactly this reason (see its comment).

logger = logging.getLogger(__name__)

# Distinct from the two metrics dispatchers (4_021_968_017 / _018) so the
# flusher never contends with them and none of the three can starve another.
_ALERT_FLUSH_ADVISORY_LOCK_KEY = 4_021_968_019

# A buffered row this old is not going to be delivered by its own cadence any
# more — the cron may never fire again (``0 0 30 2 *``), or the destination may
# have been left disabled. Dropping it is safe: a scope that is still firing
# re-buffers within one collection, so the only thing lost is a measurement
# nobody can act on. Disabling a destination clears its buffer outright
# (``alerting_service``), so this is the backstop, not the main path.
PENDING_ITEM_MAX_AGE = timedelta(days=14)


def _sweep_aged_buffer(session: Session, *, now: datetime) -> int:
    cutoff = now - PENDING_ITEM_MAX_AGE
    result = session.execute(delete(AlertPendingItem).where(AlertPendingItem.updated_at < cutoff))
    removed = int(getattr(result, "rowcount", 0) or 0)
    if removed:
        logger.warning(
            "Dropped %d alert buffer rows older than %s — their destination's "
            "cadence has not fired in that time",
            removed,
            PENDING_ITEM_MAX_AGE,
        )
    return removed


def _rehydrate(row: AlertPendingItem) -> DriftAlertCandidate:
    """Rebuild the candidate the buffer snapshotted.

    ``DriftAlertCandidate`` declares every field ``AlertMatchCandidate``
    requires plus the four drift extras dispatch reads via ``getattr``, so one
    constructor is a faithful round trip. ``id`` carries the source anomaly for
    provenance only — nothing downstream dereferences it, and the row it names
    was deleted and rewritten several collections ago.
    """
    return DriftAlertCandidate(
        id=row.source_anomaly_id or row.id,
        scan_config_id=row.scan_config_id,
        scope_type=row.scope_type,
        scope_ref=row.scope_ref,
        event_id=row.event_id,
        event_type_id=row.event_type_id,
        bucket=row.bucket,
        direction=row.direction,
        actual_count=row.actual_count,
        expected_count=row.expected_count,
        drift_field=row.drift_field,
        drift_type=row.drift_type,
        sample_value=row.sample_value,
        window_from=row.window_from,
    )


def _build_digest(
    session: Session,
    destination: AlertDestination,
    *,
    now: datetime,
) -> list[uuid.UUID]:
    """Claim this destination's buffer and mint deliveries from it.

    Returns the new delivery ids. Caller commits; this function performs no
    commit of its own, because the claim (the DELETE) and the deliveries have
    to land or roll back together.
    """
    from tripl.worker.tasks.metrics.dispatch import (
        _as_utc,
        _create_deliveries,
        _suppressed_correlation_group_ids,
    )
    from tripl.worker.tasks.metrics.urls import _get_project_slug

    claimed = list(
        session.execute(
            select(AlertPendingItem)
            .where(AlertPendingItem.destination_id == destination.id)
            # Plain FOR UPDATE, deliberately not SKIP LOCKED. The advisory lock
            # already makes the flusher single-flight, so the only transaction
            # that can hold one of these row locks is a ``collect_metrics``
            # mid-upsert — and skipping that row would drop the freshest
            # observation of the very scope that is firing hardest. Waiting for
            # its commit is bounded and yields the better digest.
            .with_for_update()
            # Deterministic input order, so the payload_snapshot JSON, the
            # AlertDeliveryItem rows and the rendered message — all three built
            # from this one list — agree with each other.
            .order_by(AlertPendingItem.bucket, AlertPendingItem.scope_name, AlertPendingItem.id)
        )
        .scalars()
        .all()
    )
    if not claimed:
        return []

    claimed_ids = [row.id for row in claimed]
    suppressed = _suppressed_correlation_group_ids(session, project_id=destination.project_id)
    project_slug = _get_project_slug(session, destination.project_id)

    rules = {
        rule.id: rule
        for rule in session.execute(
            select(AlertRule).where(AlertRule.id.in_({row.rule_id for row in claimed}))
        ).scalars()
    }
    configs = {
        config.id: config
        for config in session.execute(
            select(ScanConfig).where(ScanConfig.id.in_({row.scan_config_id for row in claimed}))
        ).scalars()
    }

    # One delivery per (rule, scan config), exactly as the immediate path
    # produces — which is what keeps the per-rule message/items templates
    # meaningful. What changes is WHEN: they all go out together, on the
    # cadence, instead of trickling out after each collection.
    grouped: dict[tuple[uuid.UUID, uuid.UUID], list[AlertPendingItem]] = defaultdict(list)
    for row in claimed:
        grouped[(row.rule_id, row.scan_config_id)].append(row)

    delivery_ids: list[uuid.UUID] = []
    for (rule_id, scan_config_id), rows in grouped.items():
        rule = rules.get(rule_id)
        config = configs.get(scan_config_id)
        if rule is None or config is None:
            # The rule or scan was deleted while its alerts waited. The rows are
            # still claimed and deleted below, so this cannot loop.
            continue
        # Re-checked at flush, not only at buffer time: an operator who
        # disables or mutes a monitor during the hold window expects the digest
        # to honour that, and on a daily cadence that window is a whole day.
        if not rule.enabled:
            continue
        muted_until = _as_utc(rule.muted_until)
        if muted_until is not None and muted_until > now:
            continue

        live = [row for row in rows if row.correlation_group_id not in suppressed]
        if not live:
            continue

        candidates: list[AlertMatchCandidate] = [_rehydrate(row) for row in live]
        delivery_ids.extend(
            _create_deliveries(
                session,
                config,
                project_slug=project_slug,
                rule=rule,
                destination=destination,
                anomalies=candidates,
                scope_names={(row.scope_type, row.scope_ref): row.scope_name for row in live},
                correlation_by_anomaly={
                    id(candidate): row.correlation_group_id
                    for candidate, row in zip(candidates, live, strict=True)
                },
                # A digest is not the product of any one scan job — its rows
                # come from however many collections happened in the window —
                # so it claims none.
                scan_job_id=None,
            )
        )

    # Delete exactly what was claimed, by id. NEVER by destination_id: a row
    # that committed between the SELECT above and this statement would be
    # destroyed without ever being delivered, and it would be unrecoverable.
    session.execute(delete(AlertPendingItem).where(AlertPendingItem.id.in_(claimed_ids)))
    return delivery_ids


@celery_app.task(name="tripl.worker.tasks.alert_flush.flush_due_alert_digests")  # type: ignore[untyped-decorator]
def flush_due_alert_digests() -> dict[str, int]:
    """Send the digest for every destination whose cadence has come round."""
    from tripl.worker.tasks.alerts import send_alert_delivery
    from tripl.worker.tasks.metrics.dispatch import _as_utc
    from tripl.worker.tasks.metrics.schedule import (
        _release_advisory_lock,
        _try_acquire_advisory_lock,
    )

    session = _get_sync_session()
    lock_conn, acquired = _try_acquire_advisory_lock(session, _ALERT_FLUSH_ADVISORY_LOCK_KEY)
    if not acquired:
        logger.info("flush_due_alert_digests: another run holds the lock; skipping this tick")
        session.close()
        return {"checked": 0, "flushed": 0, "deliveries": 0, "swept": 0}

    checked = 0
    flushed = 0
    dispatched: list[uuid.UUID] = []
    swept = 0
    try:
        now = datetime.now(UTC)
        swept = _sweep_aged_buffer(session, now=now)
        session.commit()

        # DRAIN. A destination switched back to "immediate" still holds
        # whatever accumulated under its old cadence, and the scheduled loop
        # below will never look at it again — without this the alerts would sit
        # until the 14-day sweep quietly dropped them. Ship them on the next
        # tick instead, which is what "immediate" now means for that channel.
        draining = (
            session.execute(
                select(AlertDestination)
                .join(AlertPendingItem, AlertPendingItem.destination_id == AlertDestination.id)
                .where(
                    AlertDestination.enabled.is_(True),
                    AlertDestination.delivery_schedule_cron.is_(None),
                )
                .order_by(AlertDestination.id)
                .distinct()
            )
            .scalars()
            .all()
        )
        for destination in draining:
            try:
                delivery_ids = _build_digest(session, destination, now=now)
            except Exception:
                session.rollback()
                logger.exception("Failed to drain buffer for destination %s", destination.id)
                continue
            destination.last_flushed_at = None
            session.commit()
            if delivery_ids:
                flushed += 1
                dispatched.extend(delivery_ids)

        rows = session.execute(
            select(AlertDestination, Project.timezone)
            .join(Project, Project.id == AlertDestination.project_id)
            .where(
                AlertDestination.enabled.is_(True),
                AlertDestination.delivery_schedule_cron.isnot(None),
            )
            .order_by(AlertDestination.id)
        ).all()

        for destination, project_timezone in rows:
            checked += 1
            cron = destination.delivery_schedule_cron
            if cron is None:  # pragma: no cover - filtered in SQL
                continue
            last = _as_utc(destination.last_flushed_at)

            if last is None:
                # First tick after a cadence was attached: adopt the clock and
                # send nothing. Anything already buffered waits for the next
                # real fire rather than being dumped now. A compare-and-set so
                # two workers cannot both adopt. (The API stamps this when the
                # schedule is set, so this is defence, not the usual path.)
                session.execute(
                    update(AlertDestination)
                    .where(
                        AlertDestination.id == destination.id,
                        AlertDestination.last_flushed_at.is_(None),
                    )
                    .values(last_flushed_at=now)
                    .execution_options(synchronize_session=False)
                )
                session.commit()
                continue

            try:
                fire_at = previous_fire_at(cron, tz_name=project_timezone, now=now, not_before=last)
            except ValueError:
                # One unusable expression must not stop every other
                # destination's digest. It is already rejected at write time,
                # so reaching here means the row predates that validation.
                logger.exception(
                    "Destination %s has an unusable delivery schedule %r", destination.id, cron
                )
                continue
            if fire_at is None or fire_at <= last:
                continue

            # (A) Claim the WINDOW. The only guard against a second tick or a
            # second worker shipping this same digest. Storing the fire instant
            # rather than ``now`` is what makes a repeated DST wall-clock time
            # recompute the same value and lose here instead of sending twice.
            claimed_window = int(
                getattr(
                    session.execute(
                        update(AlertDestination)
                        .where(
                            AlertDestination.id == destination.id,
                            AlertDestination.last_flushed_at < fire_at,
                        )
                        .values(last_flushed_at=fire_at)
                        .execution_options(synchronize_session=False)
                    ),
                    "rowcount",
                    0,
                )
                or 0
            )
            if claimed_window != 1:
                session.rollback()
                continue

            # (B) Claim the CONTENT, in the same transaction.
            try:
                delivery_ids = _build_digest(session, destination, now=now)
            except Exception:
                # Roll the watermark back with everything else: advancing it
                # while the rows stayed buffered would mean a full cadence
                # period of silence for alerts that were ready to go.
                session.rollback()
                logger.exception("Failed to build digest for destination %s", destination.id)
                continue

            # (C) One commit for the watermark, the deliveries and the claim.
            session.commit()

            if not delivery_ids:
                # Empty window: no message, and the watermark still advanced —
                # mandatory, or the first alert to arrive would find the window
                # still "due" and flush within a minute, turning a daily
                # destination back into a near-immediate one.
                continue
            flushed += 1
            dispatched.extend(delivery_ids)

        # Enqueued after the commit, exactly as collect_metrics does it. If a
        # publish is lost the deliveries are already `pending`, so the existing
        # stranded-delivery reaper ships them within 15 minutes.
        for delivery_id in dispatched:
            try:
                send_alert_delivery.delay(str(delivery_id))
            except Exception:
                logger.exception("Failed to dispatch digest delivery %s", delivery_id)

        return {
            "checked": checked,
            "flushed": flushed,
            "deliveries": len(dispatched),
            "swept": swept,
        }
    finally:
        _release_advisory_lock(lock_conn, _ALERT_FLUSH_ADVISORY_LOCK_KEY)
        session.close()
