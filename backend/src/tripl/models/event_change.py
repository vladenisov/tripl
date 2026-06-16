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
    field: Mapped[str] = mapped_column(String(100))
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
