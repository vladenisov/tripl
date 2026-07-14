from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class MetricValueBreakdown(UUIDMixin, Base):
    """A per-dimension slice of a collected catalog metric value.

    Mirrors ``EventMetricBreakdown`` but is keyed by ``MetricDefinition`` and
    stores a Float ``value``. The metric itself IS the scope, so the
    event/event-type scope columns carried by ``EventMetricBreakdown`` are
    dropped. ``scan_config_id`` is an optional FK used to align
    ``event_composition`` metrics onto the source scan grid.
    """

    __tablename__ = "metric_value_breakdowns"
    __table_args__ = (
        UniqueConstraint(
            "metric_definition_id",
            "scan_config_id",
            "bucket",
            "breakdown_column",
            "breakdown_value",
            "is_other",
            name="uq_metric_value_breakdown_def_config_bucket_value",
        ),
        Index(
            "uq_metric_value_breakdown_catalog_bucket_value",
            "metric_definition_id",
            "bucket",
            "breakdown_column",
            "breakdown_value",
            "is_other",
            unique=True,
            postgresql_where=text("scan_config_id IS NULL"),
            sqlite_where=text("scan_config_id IS NULL"),
        ),
        Index(
            "ix_metric_value_breakdown_def_bucket",
            "metric_definition_id",
            "bucket",
        ),
    )

    metric_definition_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("metric_definitions.id", ondelete="CASCADE"),
    )
    scan_config_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
        nullable=True,
    )
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    breakdown_column: Mapped[str] = mapped_column(String(255))
    breakdown_value: Mapped[str] = mapped_column(String(500))
    is_other: Mapped[bool] = mapped_column(Boolean, default=False)
    value: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
