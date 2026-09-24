from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import datetime

from sqlalchemy import case, select, update
from sqlalchemy.orm import Session

from tripl.models.event import Event, EventStatus
from tripl.models.event_change import create_event_change

# The statuses first data promotes to ``live``. Ordered by lifecycle rank.
AUTO_LIVE_FROM: tuple[EventStatus, ...] = (EventStatus.ready_for_dev, EventStatus.implemented)

# PostgreSQL/psycopg caps a single statement at 65535 bind parameters, so the
# batched statements below have to stay under that ceiling. We keep the same
# margin ``metric_rows`` keeps. The last_seen_at UPDATE is the widest of them:
# it spends three parameters per event — the CASE key, the CASE value and the
# IN-list entry. The CASE is rendered twice (SET and WHERE) but costs nothing
# extra: the compiler emits one named bind per branch and psycopg collapses the
# repeated placeholders onto the same server-side parameter.
_MAX_BIND_PARAMS = 60000
_MAX_EVENTS_PER_BUMP = _MAX_BIND_PARAMS // 3


def _batched[ItemT](items: list[ItemT], size: int) -> Iterator[list[ItemT]]:
    """Yield ``items`` in slices of at most ``size``."""
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _bump_event_last_seen(
    session: Session,
    *,
    event_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int],
) -> None:
    """Project the latest bucket with a non-zero count into Event.last_seen_at.

    Monotonic: we only move the column forward, so historical replays of an
    older window cannot rewind a freshly-collected last_seen_at.

    AUTO-LIVE: events with status 'ready_for_dev' or 'implemented' that receive
    fresh data are promoted to 'live'. An EventChange row (user_id=None) is
    written for the transition. The status check makes this naturally
    idempotent — already-live events are never re-transitioned.

    ``ready_for_dev`` joined ``implemented`` for tripl-kjhi.6: on production the
    handoff goes analyst → developer → data, and nobody flips the row to
    "implemented" by hand before the first rows land, so the tracker read
    "0 implemented" for a feature whose events had been firing for weeks.
    Drafts and events in review stay put — ``in_review`` is the scan's own
    review queue, and a draft reaching the warehouse is news to surface, not a
    status to skip past.

    Every write here is batched (tripl-0zpq.16). ``process_chunk`` calls this
    once per replay chunk, so a per-event round trip multiplied out to
    chunks x catalog statements on the sync worker engine, which has no
    pipelining. One chunk now costs one UPDATE, one SELECT and at most one
    UPDATE per distinct promoted-from status.
    """
    if not event_agg:
        return

    latest_by_event: dict[uuid.UUID, datetime] = {}
    for (_scan_config_id, event_id, bucket), count in event_agg.items():
        if count <= 0:
            continue
        current = latest_by_event.get(event_id)
        if current is None or bucket > current:
            latest_by_event[event_id] = bucket

    for batch in _batched(list(latest_by_event.items()), _MAX_EVENTS_PER_BUMP):
        # The CASE resolves to each row's OWN bucket, so the monotonic guard
        # stays per row exactly as the per-event form had it. The IN list is
        # load-bearing rather than redundant: without it a row outside the
        # batch would see a NULL CASE, and ``last_seen_at IS NULL`` would then
        # match it and write that NULL back over the whole table.
        #
        # synchronize_session=False: we don't need ORM identity-map sync here
        # (the writer doesn't re-read Event in the same session), and the
        # default in-memory evaluator chokes when the stored value is naive
        # (SQLite test backend) but the new bucket is tz-aware.
        bucket_case = case(dict(batch), value=Event.id)
        session.execute(
            update(Event)
            .where(
                Event.id.in_([event_id for event_id, _bucket in batch]),
                (Event.last_seen_at.is_(None)) | (Event.last_seen_at < bucket_case),
            )
            # updated_at pinned to itself: TimestampMixin's onupdate would
            # otherwise stamp now() on every bump, and this bookkeeping write
            # is not a plan edit — the activity rail orders events by
            # updated_at and re-announced every live event each tick
            # (tripl-0zpq.194).
            .values(last_seen_at=bucket_case, updated_at=Event.updated_at)
            .execution_options(synchronize_session=False)
        )

    # AUTO-LIVE: find the subset of bumped events still waiting for data and
    # promote them to 'live', writing one EventChange row per transition.
    # Collected per previous status so the promotion costs one UPDATE per
    # status present rather than one per event.
    by_previous: dict[EventStatus, list[uuid.UUID]] = {}
    for batch_ids in _batched(list(latest_by_event.keys()), _MAX_EVENTS_PER_BUMP):
        waiting_events = session.execute(
            select(Event.id, Event.status).where(
                Event.id.in_(batch_ids),
                Event.status.in_(AUTO_LIVE_FROM),
            )
        ).all()
        for eid, previous_status in waiting_events:
            previous = EventStatus(previous_status)
            by_previous.setdefault(previous, []).append(eid)
            session.add(
                create_event_change(
                    event_id=eid,
                    user_id=None,
                    field="status",
                    old_value=previous,
                    new_value=EventStatus.live,
                )
            )

    for previous, promoted_ids in by_previous.items():
        # Grouped by the previous status rather than swept with a single
        # ``status.in_(AUTO_LIVE_FROM)``: that keeps the per-row
        # ``status == previous_status`` guard the per-event form had, so a
        # concurrent ready_for_dev → implemented move still cannot be promoted
        # under a stale ``old_value``.
        for batch_ids in _batched(promoted_ids, _MAX_EVENTS_PER_BUMP):
            session.execute(
                update(Event)
                .where(Event.id.in_(batch_ids), Event.status == previous)
                .values(status=EventStatus.live)
                .execution_options(synchronize_session=False)
            )
