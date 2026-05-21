from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import update
from sqlalchemy.orm import Session

from tripl.models.event import Event


def _bump_event_last_seen(
    session: Session,
    *,
    event_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int],
) -> None:
    """Project the latest bucket with a non-zero count into Event.last_seen_at.

    Monotonic: we only move the column forward, so historical replays of an
    older window cannot rewind a freshly-collected last_seen_at.
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

    for event_id, bucket in latest_by_event.items():
        # synchronize_session=False: we don't need ORM identity-map sync here
        # (the writer doesn't re-read Event in the same session), and the
        # default in-memory evaluator chokes when the stored value is naive
        # (SQLite test backend) but the new bucket is tz-aware.
        session.execute(
            update(Event)
            .where(
                Event.id == event_id,
                (Event.last_seen_at.is_(None)) | (Event.last_seen_at < bucket),
            )
            .values(last_seen_at=bucket)
            .execution_options(synchronize_session=False)
        )
