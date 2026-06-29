from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class MetricValue(UUIDMixin, Base):
    """A single collected value of a catalog metric for one time bucket.

    Mirrors ``EventMetric`` but is keyed by ``MetricDefinition`` and stores a
    Float ``value`` (instead of a BigInteger count). ``scan_config_id`` is an
    optional FK used to align ``event_composition`` metrics onto the source
    scan grid; it is left NULL for ``sql`` / ``fact_aggregation`` metrics that
    collect from their own data source.
    """

    __tablename__ = "metric_values"
    __table_args__ = (
        UniqueConstraint(
            "metric_definition_id",
            "scan_config_id",
            "bucket",
            name="uq_metric_value_def_config_bucket",
        ),
        Index("ix_metric_value_def_bucket", "metric_definition_id", "bucket"),
    )

    metric_definition_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("metric_definitions.id", ondelete="CASCADE"),
    )
    scan_config_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
        nullable=True,
    )
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    value: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
