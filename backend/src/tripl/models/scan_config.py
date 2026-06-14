from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.data_source import DataSource
    from tripl.models.event_type import EventType
    from tripl.models.scan_job import ScanJob


class ScanConfig(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "scan_configs"
    __table_args__ = (
        UniqueConstraint("data_source_id", "name", name="uq_scan_config_ds_name"),
        Index("ix_scan_config_project", "project_id"),
    )

    data_source_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("data_sources.id", ondelete="CASCADE")
    )
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255))
    base_query: Mapped[str] = mapped_column(Text)
    event_type_column: Mapped[str | None] = mapped_column(String(255), nullable=True)
    time_column: Mapped[str | None] = mapped_column(String(255), nullable=True)
    event_name_format: Mapped[str | None] = mapped_column(String(500), nullable=True)
    json_value_paths: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    event_group_rules: Mapped[list[dict[str, object]]] = mapped_column(
        JSON,
        default=list,
        server_default="[]",
    )
    metric_breakdown_columns: Mapped[list[str]] = mapped_column(
        JSON,
        default=list,
        server_default="[]",
    )
    metric_breakdown_values_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    distribution_drift_fields: Mapped[list[str]] = mapped_column(
        JSON,
        default=list,
        server_default="[]",
    )
    cardinality_threshold: Mapped[int] = mapped_column(Integer, default=100)
    interval: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Splits the metrics collection window into interval-aligned chunks so a long
    # replay runs several bounded warehouse queries instead of one that times out.
    # Must be >= ``interval``; NULL means "scan the whole window in one query".
    replay_chunk_interval: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Optional lookback for manual scan/preview catalog sync. Scheduled metrics
    # catalog sync uses the collection window when this is unset.
    scan_lookback_hours: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Optional override for GROUP BY ALL scan query row cap.
    scan_row_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Optional override for time-bucketed replay/metrics query row caps.
    metrics_row_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Optional column holding the app/build version (e.g. "2.10.0"). When set,
    # per-version metric series are collected and release regressions detected.
    # NULL means version observation is fully disabled (e.g. web scans with no
    # app version) and the whole version pipeline is inert.
    app_version_column: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # How many latest releases (by semver order) to retain/observe; older
    # releases collapse into an "other" bucket. NULL falls back to a system
    # default at collection time.
    app_version_keep_releases: Mapped[int | None] = mapped_column(Integer, nullable=True)
    anomaly_detection_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    detect_project_total: Mapped[bool] = mapped_column(Boolean, default=True)
    detect_event_types: Mapped[bool] = mapped_column(Boolean, default=True)
    detect_events: Mapped[bool] = mapped_column(Boolean, default=True)
    baseline_window_buckets: Mapped[int] = mapped_column(Integer, default=14)
    min_history_buckets: Mapped[int] = mapped_column(Integer, default=7)
    sigma_threshold: Mapped[float] = mapped_column(Float, default=3.0)
    min_expected_count: Mapped[int] = mapped_column(Integer, default=10)

    data_source: Mapped[DataSource] = relationship(back_populates="scan_configs")
    event_type: Mapped[EventType | None] = relationship()
    scan_jobs: Mapped[list[ScanJob]] = relationship(
        back_populates="scan_config", cascade="all, delete-orphan", lazy="selectin"
    )
