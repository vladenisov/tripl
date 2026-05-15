from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.event_field_value import EventFieldValue
    from tripl.models.event_meta_value import EventMetaValue
    from tripl.models.event_tag import EventTag
    from tripl.models.event_type import EventType


class Event(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "events"
    __table_args__ = (
        Index("ix_event_project_order", "project_id", "order"),
        Index("ix_event_event_type", "event_type_id"),
        Index("ix_events_last_seen_at", "last_seen_at"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    event_type_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("event_types.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(500))
    description: Mapped[str] = mapped_column(Text, default="")
    order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    implemented: Mapped[bool] = mapped_column(Boolean, default=False)
    reviewed: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    event_type: Mapped[EventType] = relationship(lazy="selectin")
    field_values: Mapped[list[EventFieldValue]] = relationship(
        back_populates="event", cascade="all, delete-orphan", lazy="selectin"
    )
    meta_values: Mapped[list[EventMetaValue]] = relationship(
        back_populates="event", cascade="all, delete-orphan", lazy="selectin"
    )
    tags: Mapped[list[EventTag]] = relationship(
        back_populates="event", cascade="all, delete-orphan", lazy="selectin"
    )
