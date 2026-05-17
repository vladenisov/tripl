from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class PlanRevision(UUIDMixin, Base):
    """Immutable snapshot of a project's tracking plan at a point in time.

    Each row stores the full schema payload (event_types, events, variables,
    relations, meta_fields) so a diff between two revisions does not need to
    re-query — useful when entities have since been deleted.
    """

    __tablename__ = "plan_revisions"
    __table_args__ = (
        Index("ix_plan_revisions_project_created", "project_id", "created_at"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    summary: Mapped[str] = mapped_column(Text, default="", server_default="")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
