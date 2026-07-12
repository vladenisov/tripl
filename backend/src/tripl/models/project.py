from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import ProjectGenerationStatus
from tripl.models.enum_types import db_enum

if TYPE_CHECKING:
    from tripl.models.event_type import EventType
    from tripl.models.event_type_relation import EventTypeRelation
    from tripl.models.meta_field_definition import MetaFieldDefinition
    from tripl.models.variable import Variable


class Project(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "projects"

    name: Mapped[str] = mapped_column(String(255))
    slug: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")

    # ── Demo identity & provisioning lifecycle ─────────────────────────────
    # A demo is a first-class, generated project. Identity is this explicit
    # flag — never the slug, DataSource name, or host — so provisioning,
    # reset, cleanup, and runtime maintenance can target demos precisely.
    is_demo: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )
    # Which demo scenario recipe produced this workspace, so a reset or a
    # future migration can tell what shape to expect. NULL for real projects.
    demo_recipe_version: Mapped[str | None] = mapped_column(String(32), nullable=True, default=None)
    # Provisioning state machine. Real projects are ``ready`` from creation;
    # demos flow seeding -> ready / failed. Non-``ready`` demos are hidden from
    # normal project lists so a partial/failed demo never looks real.
    generation_status: Mapped[str] = mapped_column(
        db_enum(ProjectGenerationStatus, "project_generation_status"),
        default=ProjectGenerationStatus.ready.value,
        server_default=ProjectGenerationStatus.ready.value,
        nullable=False,
    )
    # Coarse label of the last provisioning step (progress hint). NULL when idle.
    generation_stage: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None)
    # Safe, user-facing failure summary when ``generation_status`` is ``failed``.
    # Never carries internals (stack traces, SQL, secrets).
    generation_error: Mapped[str | None] = mapped_column(Text, nullable=True, default=None)
    # Provenance: who created this project (demo self-service or otherwise). Lets
    # the creator manage their own demo without full owner rights. SET NULL so a
    # deleted user does not delete their projects.
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, default=None
    )
    # When demo content last finished seeding — the anchor for retention and
    # runtime maintenance ticks. NULL until the first successful seed.
    demo_seeded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # When the demo-runtime tick (``advance_demos``) last advanced this demo's
    # synthetic clock. NULL until the first tick. Diagnostic/observability only —
    # the tick's correctness comes from the seeded series + DB unique constraints,
    # not this stamp.
    demo_last_tick_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # Last explicit activity on this demo (a GET on the project, a reset/run). The
    # tick uses this to pause demos nobody is looking at (older than
    # ``DEMO_IDLE_PAUSE_MINUTES``) so inactive demos stop consuming worker time;
    # the next access resumes them. NULL falls back to ``demo_seeded_at``.
    demo_last_accessed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )

    event_types: Mapped[list[EventType]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )
    meta_field_definitions: Mapped[list[MetaFieldDefinition]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )
    relations: Mapped[list[EventTypeRelation]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )
    variables: Mapped[list[Variable]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin"
    )
