from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.plan_branch import default_branch_id

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
        Index("ix_events_source_identity", "project_id", "event_type_id", "source_name"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    branch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_branches.id", ondelete="CASCADE"), index=True, default=default_branch_id
    )
    event_type_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("event_types.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(500))
    # Stable scan identity: the name as derived from the source columns named in the
    # scan's ``event_name_format``. Dedup/metric matching keys on this, NOT on ``name``,
    # so users can freely rename ``name`` without the next scan creating duplicates.
    # Null for events created outside a scan (e.g. via the API); backfilled lazily.
    source_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    description: Mapped[str] = mapped_column(Text, default="")
    order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    implemented: Mapped[bool] = mapped_column(Boolean, default=False)
    reviewed: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    metric_breakdown_columns: Mapped[list[str]] = mapped_column(
        JSON,
        default=list,
        server_default="[]",
    )

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
