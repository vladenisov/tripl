from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from tripl.core.adapters.measure_validator import (
    validate_identifier,
    validate_select_sql_safety,
    validate_sql_fragment,
)
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricKind,
    MetricStatus,
    ScanInterval,
)
from tripl.schemas.event_metric import MetricSignalResponse
from tripl.schemas.scan_config import check_replay_chunk_against_interval


def _validate_optional_identifier(value: str | None) -> str | None:
    """Run ``validate_identifier`` on a non-None identifier-class field.

    Identifier-class fields flow into warehouse SQL with no bound parameters, so
    the schema boundary is the only gate. ``None`` (the field is absent) is left
    untouched; any provided value must pass the allowlist regex or raise.
    """
    return value if value is None else validate_identifier(value)


# Aggregations that operate on a measure column. ``count`` is the only one that
# does not — it counts rows and needs no column.
_AGGREGATIONS_REQUIRING_MEASURE = frozenset(
    {
        MetricAggregation.sum,
        MetricAggregation.avg,
        MetricAggregation.min,
        MetricAggregation.max,
        MetricAggregation.count_distinct,
    }
)


# ── Kind-specific config payloads ────────────────────────────────────────────


class FactAggregationConfig(BaseModel):
    """Config JSON for a ``fact_aggregation`` metric.

    Requires a source: either ``source_table`` (a warehouse table) or
    ``base_query`` (a base SELECT). ``measure_column`` is required by the
    enclosing metric when the aggregation is not ``count`` (enforced there,
    since the aggregation lives on the metric, not in this config).
    """

    model_config = ConfigDict(extra="forbid")

    source_table: str | None = Field(default=None, min_length=1, max_length=255)
    base_query: str | None = Field(default=None, min_length=1)
    measure_column: str | None = Field(default=None, min_length=1, max_length=255)
    distinct_column: str | None = Field(default=None, min_length=1, max_length=255)
    filter_sql: str | None = Field(default=None, min_length=1)
    time_column: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("source_table", "measure_column", "distinct_column", "time_column")
    @classmethod
    def _check_identifier_fields(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)

    @field_validator("filter_sql")
    @classmethod
    def _check_filter_sql(cls, value: str | None) -> str | None:
        return value if value is None else validate_sql_fragment(value)

    @field_validator("base_query")
    @classmethod
    def _check_base_query(cls, value: str | None) -> str | None:
        return value if value is None else validate_select_sql_safety(value)

    @model_validator(mode="after")
    def validate_source(self) -> FactAggregationConfig:
        if not self.source_table and not self.base_query:
            raise ValueError("fact_aggregation config requires either source_table or base_query")
        return self


class SqlConfig(BaseModel):
    """Config JSON for a ``sql`` metric: a user-authored per-bucket SELECT."""

    model_config = ConfigDict(extra="forbid")

    metric_sql: str = Field(min_length=1)
    time_column: str = Field(min_length=1, max_length=255)

    @field_validator("metric_sql")
    @classmethod
    def _check_metric_sql(cls, value: str) -> str:
        return validate_select_sql_safety(value)

    @field_validator("time_column")
    @classmethod
    def _check_time_column(cls, value: str) -> str:
        return validate_identifier(value)


# ── Shared catalog fields ────────────────────────────────────────────────────


class _MetricDefinitionBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    display_name: str = Field(min_length=1, max_length=255)
    description: str = ""
    color: str = Field(default="#6366f1", pattern=r"^#[0-9a-fA-F]{6}$")
    order: int = 0
    unit: str | None = Field(default=None, max_length=50)
    status: MetricStatus = MetricStatus.draft
    owner_id: uuid.UUID | None = None
    reviewed: bool = False
    breakdown_columns: list[str] = Field(default_factory=list)
    breakdown_values_limit: int | None = Field(default=None, ge=1)
    app_version_column: str | None = Field(default=None, min_length=1, max_length=255)
    platform_column: str | None = Field(default=None, min_length=1, max_length=255)
    anomaly_detection_enabled: bool = True

    @field_validator("app_version_column", "platform_column")
    @classmethod
    def _check_optional_identifier_columns(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)

    @field_validator("breakdown_columns")
    @classmethod
    def _check_breakdown_columns(cls, value: list[str]) -> list[str]:
        return [validate_identifier(item) for item in value]

    def _shared_values(self) -> dict[str, object]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "color": self.color,
            "order": self.order,
            "unit": self.unit,
            "status": self.status,
            "owner_id": self.owner_id,
            "reviewed": self.reviewed,
            "breakdown_columns": self.breakdown_columns,
            "breakdown_values_limit": self.breakdown_values_limit,
            "app_version_column": self.app_version_column,
            "platform_column": self.platform_column,
            "anomaly_detection_enabled": self.anomaly_detection_enabled,
        }


# ── Discriminated create variants ────────────────────────────────────────────


class FactAggregationMetricCreate(_MetricDefinitionBase):
    kind: Literal[MetricKind.fact_aggregation] = MetricKind.fact_aggregation
    aggregation: MetricAggregation
    config: FactAggregationConfig
    data_source_id: uuid.UUID
    interval: ScanInterval
    replay_chunk_interval: ScanInterval | None = None

    @model_validator(mode="after")
    def validate_kind(self) -> FactAggregationMetricCreate:
        if self.aggregation in _AGGREGATIONS_REQUIRING_MEASURE and not self.config.measure_column:
            raise ValueError(
                f"measure_column is required for aggregation '{self.aggregation.value}'"
            )
        check_replay_chunk_against_interval(
            interval=self.interval,
            replay_chunk_interval=self.replay_chunk_interval,
        )
        return self

    def to_create_values(self) -> dict[str, object]:
        return {
            **self._shared_values(),
            "kind": self.kind,
            "aggregation": self.aggregation,
            "composition": None,
            "config": self.config.model_dump(),
            "data_source_id": self.data_source_id,
            "interval": self.interval,
            "replay_chunk_interval": self.replay_chunk_interval,
            "numerator_event_id": None,
            "numerator_event_type_id": None,
            "denominator_event_id": None,
            "denominator_event_type_id": None,
        }


class SqlMetricCreate(_MetricDefinitionBase):
    kind: Literal[MetricKind.sql] = MetricKind.sql
    config: SqlConfig
    data_source_id: uuid.UUID
    interval: ScanInterval
    replay_chunk_interval: ScanInterval | None = None

    @model_validator(mode="after")
    def validate_kind(self) -> SqlMetricCreate:
        check_replay_chunk_against_interval(
            interval=self.interval,
            replay_chunk_interval=self.replay_chunk_interval,
        )
        return self

    def to_create_values(self) -> dict[str, object]:
        return {
            **self._shared_values(),
            "kind": self.kind,
            "aggregation": None,
            "composition": None,
            "config": self.config.model_dump(),
            "data_source_id": self.data_source_id,
            "interval": self.interval,
            "replay_chunk_interval": self.replay_chunk_interval,
            "numerator_event_id": None,
            "numerator_event_type_id": None,
            "denominator_event_id": None,
            "denominator_event_type_id": None,
        }


class EventCompositionMetricCreate(_MetricDefinitionBase):
    """Derived from already-collected event_metrics; no data source / interval.

    Numerator/denominator are each given as exactly one ref: an ``event_id`` or
    an ``event_type_id``. ``single``/``per_distinct_user`` use the numerator
    only; ``ratio`` requires both numerator and denominator.
    """

    kind: Literal[MetricKind.event_composition] = MetricKind.event_composition
    composition: MetricComposition
    numerator_event_id: uuid.UUID | None = None
    numerator_event_type_id: uuid.UUID | None = None
    denominator_event_id: uuid.UUID | None = None
    denominator_event_type_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def validate_kind(self) -> EventCompositionMetricCreate:
        _validate_single_ref(
            self.numerator_event_id,
            self.numerator_event_type_id,
            role="numerator",
            required=True,
        )
        denominator_required = self.composition == MetricComposition.ratio
        _validate_single_ref(
            self.denominator_event_id,
            self.denominator_event_type_id,
            role="denominator",
            required=denominator_required,
        )
        return self

    def to_create_values(self) -> dict[str, object]:
        return {
            **self._shared_values(),
            "kind": self.kind,
            "aggregation": None,
            "composition": self.composition,
            "config": {},
            "data_source_id": None,
            "interval": None,
            "replay_chunk_interval": None,
            "numerator_event_id": self.numerator_event_id,
            "numerator_event_type_id": self.numerator_event_type_id,
            "denominator_event_id": self.denominator_event_id,
            "denominator_event_type_id": self.denominator_event_type_id,
        }


def _validate_single_ref(
    event_id: uuid.UUID | None,
    event_type_id: uuid.UUID | None,
    *,
    role: str,
    required: bool,
) -> None:
    provided = [ref for ref in (event_id, event_type_id) if ref is not None]
    if not provided:
        if required:
            raise ValueError(f"{role} requires an event_id or event_type_id")
        return
    if len(provided) > 1:
        raise ValueError(f"{role} accepts only one of event_id or event_type_id")


MetricDefinitionCreate = Annotated[
    FactAggregationMetricCreate | SqlMetricCreate | EventCompositionMetricCreate,
    Field(discriminator="kind"),
]


# ── Update / bulk ────────────────────────────────────────────────────────────


class MetricDefinitionUpdate(BaseModel):
    """Partial update of presentation, lifecycle, dimension and monitoring fields.

    ``kind``/``config`` and the collection binding define a metric's identity and
    are immutable here — recreate the metric to change them (mirrors the simple
    EventType update surface).
    """

    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    order: int | None = None
    unit: str | None = Field(default=None, max_length=50)
    status: MetricStatus | None = None
    owner_id: uuid.UUID | None = None
    reviewed: bool | None = None
    breakdown_columns: list[str] | None = None
    breakdown_values_limit: int | None = Field(default=None, ge=1)
    app_version_column: str | None = Field(default=None, max_length=255)
    platform_column: str | None = Field(default=None, max_length=255)
    anomaly_detection_enabled: bool | None = None

    @field_validator("app_version_column", "platform_column")
    @classmethod
    def _check_optional_identifier_columns(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)

    @field_validator("breakdown_columns")
    @classmethod
    def _check_breakdown_columns(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else [validate_identifier(item) for item in value]


class MetricDefinitionBulkUpdate(BaseModel):
    metric_ids: list[uuid.UUID] = Field(min_length=1)
    status: MetricStatus | None = None
    owner_id: uuid.UUID | None = None
    reviewed: bool | None = None
    anomaly_detection_enabled: bool | None = None

    @model_validator(mode="after")
    def validate_has_update(self) -> MetricDefinitionBulkUpdate:
        # Use the set of explicitly-provided fields so an explicit ``owner_id:
        # null`` counts as an update (it unassigns the owner) rather than being
        # treated as "no value given".
        if not (self.model_fields_set - {"metric_ids"}):
            raise ValueError(
                "At least one of status, owner_id, reviewed or "
                "anomaly_detection_enabled must be provided"
            )
        return self


class MetricDefinitionReorder(BaseModel):
    metric_ids: list[uuid.UUID] = Field(min_length=1)


class MetricDefinitionMove(BaseModel):
    direction: Literal["up", "down"]
    visible_metric_ids: list[uuid.UUID] | None = None


# ── Read models ──────────────────────────────────────────────────────────────


class MetricDefinitionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    display_name: str
    description: str
    color: str
    order: int
    unit: str | None
    status: MetricStatus
    owner_id: uuid.UUID | None
    reviewed: bool
    kind: MetricKind
    aggregation: MetricAggregation | None
    composition: MetricComposition | None
    config: dict[str, object]
    breakdown_columns: list[str]
    breakdown_values_limit: int | None
    app_version_column: str | None
    platform_column: str | None
    data_source_id: uuid.UUID | None
    interval: ScanInterval | None
    replay_chunk_interval: ScanInterval | None
    numerator_event_id: uuid.UUID | None
    numerator_event_type_id: uuid.UUID | None
    denominator_event_id: uuid.UUID | None
    denominator_event_type_id: uuid.UUID | None
    anomaly_detection_enabled: bool
    last_collected_at: datetime | None
    last_collection_status: str | None
    last_collection_error: str | None
    created_at: datetime
    updated_at: datetime


class MetricDefinitionListItem(BaseModel):
    """Slim list row: the catalog table fields, without the heavier config/refs."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    display_name: str
    description: str
    color: str
    order: int
    unit: str | None
    status: MetricStatus
    owner_id: uuid.UUID | None
    reviewed: bool
    kind: MetricKind
    aggregation: MetricAggregation | None
    composition: MetricComposition | None
    interval: ScanInterval | None
    anomaly_detection_enabled: bool
    last_collected_at: datetime | None
    last_collection_status: str | None
    created_at: datetime
    updated_at: datetime

    # --- Read-time enrichment (populated by the list service, not the ORM) ---
    # Latest collected value + its bucket, the latest open anomaly signal, and a
    # short sparkline of recent values — for the catalog row's value/status/spark
    # cells. All default to "no data" so the model validates straight off the ORM
    # before enrichment is merged in.
    latest_value: float | None = None
    latest_bucket: datetime | None = None
    latest_signal: MetricSignalResponse | None = None
    spark: list[float] = []


class MetricDefinitionListResponse(BaseModel):
    items: list[MetricDefinitionListItem]
    total: int
