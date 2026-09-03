from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.enum_types import db_enum
from tripl.models.plan_branch import default_branch_id

if TYPE_CHECKING:
    from tripl.models.event_field_value import EventFieldValue
    from tripl.models.event_meta_value import EventMetaValue
    from tripl.models.event_tag import EventTag
    from tripl.models.event_type import EventType


class EventStatus(enum.StrEnum):
    draft = "draft"
    in_review = "in_review"
    ready_for_dev = "ready_for_dev"
    implemented = "implemented"
    live = "live"
    deprecated = "deprecated"
    archived = "archived"


_STATUS_RANK: dict[EventStatus, int] = {
    EventStatus.draft: 0,
    EventStatus.in_review: 1,
    EventStatus.ready_for_dev: 2,
    EventStatus.implemented: 3,
    EventStatus.live: 4,
    EventStatus.deprecated: 5,
    EventStatus.archived: 6,
}


def event_status_rank(status: EventStatus) -> int:
    return _STATUS_RANK.get(status, 0)


class Event(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "events"
    __table_args__ = (
        Index("ix_event_project_order", "project_id", "order"),
        Index("ix_event_event_type", "event_type_id"),
        Index("ix_events_last_seen_at", "last_seen_at"),
        # One event per scan identity, enforced by the schema. An event type
        # lives on exactly one branch of one project (``uq_event_type_project_name``
        # is per branch, and a branch copy gets its own types), so
        # ``event_type_id`` alone scopes the identity the way ``generate_events``
        # and ``_identities_already_held`` scope their lookups — per project, per
        # branch, per type — and the key names only the two columns that carry
        # information. NULL stays free: an event authored outside a scan rule has
        # no identity yet, and the database treats NULLs as distinct, so any
        # number of them coexist until a scan adopts a name (tripl-8tdl). This
        # replaces the plain ``ix_events_source_identity`` index, which promised
        # nothing and let production hold two rows per identity.
        UniqueConstraint("event_type_id", "source_name", name="uq_event_scan_identity"),
        Index("ix_events_project_branch_status", "project_id", "branch_id", "status"),
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
    status: Mapped[str] = mapped_column(
        db_enum(EventStatus, "event_status"),
        default=EventStatus.draft,
        server_default=EventStatus.draft.value,
        nullable=False,
    )
    sunset_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    metric_breakdown_columns: Mapped[list[str]] = mapped_column(
        JSON,
        default=list,
        server_default="[]",
    )
    # Per-event ownership (nullable) and review state. Owner is resolved to a
    # user by the frontend from its own users list; we keep only the id here.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reviewed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
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
