from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
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


class MetricAnomaly(UUIDMixin, Base):
    __tablename__ = "metric_anomalies"
    __table_args__ = (
        UniqueConstraint(
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "bucket",
            name="uq_metric_anomaly_scope_bucket",
        ),
        Index(
            "ix_metric_anomaly_scope_bucket",
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "bucket",
        ),
        Index("ix_metric_anomaly_event_bucket", "event_id", "bucket"),
        Index("ix_metric_anomaly_type_bucket", "event_type_id", "bucket"),
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
    actual_count: Mapped[int] = mapped_column(BigInteger)
    expected_count: Mapped[float] = mapped_column(Float)
    stddev: Mapped[float] = mapped_column(Float)
    z_score: Mapped[float] = mapped_column(Float)
    direction: Mapped[str] = mapped_column(db_enum(AnomalyDirection, "anomaly_direction"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
