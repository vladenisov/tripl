from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import ChartAnnotationScopeType
from tripl.models.enum_types import db_enum


class ChartAnnotation(UUIDMixin, TimestampMixin, Base):
    """Vertical marker overlaid on metric charts.

    Project-wide markers (scope_type IS NULL) appear on every chart inside
    the project; scoped markers only show on charts matching the
    (scope_type, scope_ref) pair — e.g. an outage on a single event_type.
    """

    __tablename__ = "chart_annotations"

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    scope_type: Mapped[str | None] = mapped_column(
        db_enum(ChartAnnotationScopeType, "chart_annotation_scope_type"), nullable=True
    )
    scope_ref: Mapped[str | None] = mapped_column(String(120), nullable=True)
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    label: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    color: Mapped[str] = mapped_column(String(20), default="#ef4444", server_default="#ef4444")
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
