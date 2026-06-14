from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin
from tripl.models.domain_enums import AnomalyDirection, MetricScopeType
from tripl.models.enum_types import db_enum


class MetricBreakdownAnomaly(UUIDMixin, Base):
    __tablename__ = "metric_breakdown_anomalies"
    __table_args__ = (
        UniqueConstraint(
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "breakdown_column",
            "breakdown_value",
            "is_other",
            "bucket",
            name="uq_metric_breakdown_anomaly_scope_bucket_value",
        ),
        Index(
            "ix_metric_breakdown_anomaly_scope_bucket",
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "breakdown_column",
            "breakdown_value",
            "is_other",
            "bucket",
        ),
        Index(
            "ix_metric_breakdown_anomaly_event_bucket",
            "event_id",
            "breakdown_column",
            "bucket",
        ),
        Index(
            "ix_metric_breakdown_anomaly_type_bucket",
            "event_type_id",
            "breakdown_column",
            "bucket",
        ),
    )

    scan_config_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
    )
    scope_type: Mapped[str] = mapped_column(db_enum(MetricScopeType, "metric_scope_type"))
    scope_ref: Mapped[str] = mapped_column(String(64))
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="SET NULL"),
        nullable=True,
    )
    event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="SET NULL"),
        nullable=True,
    )
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    breakdown_column: Mapped[str] = mapped_column(String(255))
    breakdown_value: Mapped[str] = mapped_column(String(500))
    is_other: Mapped[bool] = mapped_column(Boolean, default=False)
    actual_count: Mapped[int] = mapped_column(BigInteger)
    expected_count: Mapped[float] = mapped_column(Float)
    stddev: Mapped[float] = mapped_column(Float)
    z_score: Mapped[float] = mapped_column(Float)
    direction: Mapped[str] = mapped_column(db_enum(AnomalyDirection, "anomaly_direction"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
