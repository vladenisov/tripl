from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricKind,
    MetricStatus,
    ScanInterval,
)
from tripl.models.enum_types import db_enum


class MetricDefinition(UUIDMixin, TimestampMixin, Base):
    """A user-defined metric in the catalog, monitored alongside events.

    Metrics are a GLOBAL, project-scoped layer (NOT plan-branched): they carry
    ``project_id`` only and are excluded from branch deep-copy/merge. An
    ``event_composition`` metric references canonical (main-branch) events via the
    numerator/denominator FKs; those ids are taken from main and may drift if the
    referenced rows are replaced by a branch merge (an accepted trade-off of the
    global model).

    A metric is defined in one of three ``kind``s:
    - ``fact_aggregation``: an aggregation (``aggregation``) over a measure column
      of a warehouse table / base SELECT (config: ``source_table``/``base_query``,
      ``measure_column``, ``distinct_column``, ``filter_sql``, ``time_column``).
    - ``sql``: a user-authored SELECT returning a per-bucket measure (config:
      ``metric_sql``, ``time_column``).
    - ``event_composition``: derived from already-collected ``event_metrics`` —
      ``single`` count, ``ratio`` A/B, or ``per_distinct_user`` (``composition``
      + numerator/denominator refs).
    """

    __tablename__ = "metric_definitions"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_metric_def_project_name"),
        Index("ix_metric_def_project_order", "project_id", "order"),
        Index("ix_metric_def_project_status", "project_id", "status"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))

    # --- Catalog presentation (mirrors EventType) ---
    name: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(7), default="#6366f1")
    order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Display unit hint, e.g. "count", "%", "ms", "users". NULL = unitless.
    unit: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # --- Lifecycle (SIMPLE: no 7-state machine, no merge-rank) ---
    status: Mapped[str] = mapped_column(
        db_enum(MetricStatus, "metric_status"),
        default=MetricStatus.draft,
        server_default=MetricStatus.draft.value,
        nullable=False,
    )
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reviewed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )

    # --- Definition kind + kind-specific config ---
    kind: Mapped[str] = mapped_column(db_enum(MetricKind, "metric_kind"), nullable=False)
    # Aggregation for ``fact_aggregation`` (count/sum/avg/min/max/count_distinct).
    aggregation: Mapped[str | None] = mapped_column(
        db_enum(MetricAggregation, "metric_aggregation"), nullable=True
    )
    # Composition operator for ``event_composition`` (single/ratio/per_distinct_user).
    composition: Mapped[str | None] = mapped_column(
        db_enum(MetricComposition, "metric_composition"), nullable=True
    )
    # Free-form, kind-specific scalar config validated by a Pydantic discriminated
    # union at the schema boundary. fact_aggregation: source_table/base_query,
    # measure_column, distinct_column, filter_sql, time_column. sql: metric_sql,
    # time_column.
    config: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, server_default="{}")

    # --- Dimensions (mirror ScanConfig breakdown/version/platform) ---
    breakdown_columns: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    breakdown_values_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    app_version_column: Mapped[str | None] = mapped_column(String(255), nullable=True)
    platform_column: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # --- Collection binding (HYBRID) ---
    # sql/fact_aggregation collect from their own data source on their own interval.
    # event_composition leaves these NULL and reads event_metrics on the source grid.
    data_source_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("data_sources.id", ondelete="SET NULL"), nullable=True
    )
    interval: Mapped[str | None] = mapped_column(
        db_enum(ScanInterval, "scan_interval"), nullable=True
    )
    # Splits a long collection window into interval-aligned chunks (see ScanConfig).
    replay_chunk_interval: Mapped[str | None] = mapped_column(
        db_enum(ScanInterval, "scan_interval"), nullable=True
    )

    # --- event_composition references (canonical main-branch events) ---
    numerator_event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )
    numerator_event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="SET NULL"), nullable=True
    )
    denominator_event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )
    denominator_event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="SET NULL"), nullable=True
    )

    # --- Monitoring ---
    anomaly_detection_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true", nullable=False
    )

    # --- Collection status (inline for v1; a job table can come later) ---
    last_collected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_collection_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_collection_error: Mapped[str | None] = mapped_column(Text, nullable=True)
