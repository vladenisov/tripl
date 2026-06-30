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
    text,
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
        # ``metric``-scope rows (catalog MetricDefinition series) carry a NULL
        # ``scan_config_id`` and are keyed purely by ``scope_ref`` (the metric
        # definition id), so the series read/recompute paths look them up by
        # (scope_ref, bucket).
        Index("ix_metric_anomaly_scope_ref_bucket", "scope_ref", "bucket"),
        # Idempotency for project-global ``metric``-scope rows. The composite
        # ``uq_metric_anomaly_scope_bucket`` cannot dedupe them because it
        # includes ``scan_config_id`` and SQL treats NULLs as DISTINCT, so
        # ``(NULL, 'metric', ref, bucket)`` rows from concurrent recompute runs
        # never conflict. This partial unique index excludes ``scan_config_id``
        # and only covers the NULL space, giving the recompute upsert a real
        # conflict target.
        Index(
            "uq_metric_anomaly_metric_scope",
            "scope_type",
            "scope_ref",
            "bucket",
            unique=True,
            postgresql_where=text("scan_config_id IS NULL"),
            sqlite_where=text("scan_config_id IS NULL"),
        ),
    )

    # NULL for ``metric``-scope rows: catalog metric anomalies are project-global
    # and not tied to a single scan config. Event scopes always set it.
    scan_config_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
        nullable=True,
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
