from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, UUIDMixin
from tripl.models.domain_enums import SchemaDriftStatus
from tripl.models.enum_types import db_enum
from tripl.models.schema_drift import SCHEMA_DRIFT_STATUS_OPEN

if TYPE_CHECKING:
    from tripl.models.event import Event
    from tripl.models.variable import Variable


class VariableValueDrift(UUIDMixin, Base):
    """Observed variable values outside the documented list, per event.

    One row per (variable, event); the scan upsert refreshes
    ``observed_values``/``detected_at`` but never touches ``status``, so
    accepted/false-positive rows age out through the read-time retention
    window exactly like schema drift.
    """

    __tablename__ = "variable_value_drifts"
    __table_args__ = (
        UniqueConstraint("variable_id", "event_id", name="uq_variable_value_drift_context"),
        Index("ix_variable_value_drifts_project_detected", "project_id", "detected_at"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    variable_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("variables.id", ondelete="CASCADE"), index=True
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), index=True
    )
    scan_config_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="SET NULL"), nullable=True
    )
    observed_values: Mapped[list[str]] = mapped_column(sa.JSON, default=list, server_default="[]")
    status: Mapped[str] = mapped_column(
        db_enum(SchemaDriftStatus, "schema_drift_status"),
        default=SCHEMA_DRIFT_STATUS_OPEN,
        server_default=SCHEMA_DRIFT_STATUS_OPEN,
    )
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    snoozed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    variable: Mapped[Variable] = relationship(lazy="selectin")
    event: Mapped[Event] = relationship(lazy="selectin")

    @property
    def variable_name(self) -> str:
        return self.variable.name

    @property
    def event_name(self) -> str:
        return self.event.name
