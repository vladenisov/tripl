from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class EventChange(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "event_changes"
    __table_args__ = (Index("ix_event_changes_event_id", "event_id"),)

    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    #: Either a tracked attribute name (``status``, ``sunset_at``, ``tags``) or a
    #: KEYED entry, ``field:<field name>`` / ``meta:<meta field name>``, written by
    #: ``event_service._record_keyed_changes`` and split back apart by
    #: ``frontend/src/lib/eventHistory.ts``. Both name columns are ``String(100)``
    #: and both create schemas allow the full 100, so a keyed entry can be 106
    #: characters — six more than the 100 this column held until tripl-0zpq.256,
    #: which made editing such a field a rolled-back 500 on PostgreSQL
    #: (StringDataRightTruncation at flush) while SQLite, which does not enforce
    #: VARCHAR widths, stored it happily in the tests. 255 rather than a tight 106
    #: so a longer prefix or a wider name column does not reopen the same hole.
    field: Mapped[str] = mapped_column(String(255))
    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)


def create_event_change(
    *,
    event_id: uuid.UUID,
    user_id: uuid.UUID | None,
    field: str,
    old_value: str | None,
    new_value: str | None,
) -> EventChange:
    now = datetime.now(UTC)
    return EventChange(
        event_id=event_id,
        user_id=user_id,
        field=field,
        old_value=old_value,
        new_value=new_value,
        created_at=now,
        updated_at=now,
    )
