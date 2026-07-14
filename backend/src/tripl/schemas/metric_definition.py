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


def _validate_row_filter_names(value: list[str]) -> list[str]:
    """Validate a list of named-filter references (labels, not raw SQL).

    Each name is matched by equality against the fact table's stored row-filter
    names at collection time; the name itself never reaches SQL, so only a
    non-empty / length bound is enforced here (membership is checked in the
    service, which needs the DB). Raises ``ValueError`` on an empty or overlong
    entry.
    """
    names: list[str] = []
    for raw in value:
        if not raw or not raw.strip():
            raise ValueError("row_filters entries must be non-empty")
        if len(raw) > 255:
            raise ValueError("row_filters entries must be at most 255 characters")
        names.append(raw)
    return names


def _validate_optional_filter_sql(value: str | None) -> str | None:
    """Validate a free-text ``filter_sql`` WHERE fragment at the schema boundary.

    ``filter_sql`` reaches warehouse SQL with no bound parameters, so it is
    guarded with the SAME validator as a fact table's named row filter
    (``validate_sql_fragment``): it rejects comment markers, ``;`` separators,
    and DDL/DML/``UNION``/subquery keywords. An empty-after-strip value is
    rejected; ``None`` (absent) passes through unchanged.
    """
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        raise ValueError("filter_sql must not be empty")
    return validate_sql_fragment(stripped)


def _fold_row_filters(row_filters: list[str], row_filter: str | None) -> list[str]:
    """Fold a legacy single ``row_filter`` name into the ``row_filters`` set.

    The effective named-filter set is ``row_filters`` plus a present legacy
    ``row_filter`` (appended if not already present). Order is preserved and
    duplicates removed so the set — and the WHERE it assembles at collection
    time — is deterministic.
    """
    effective: list[str] = []
    for name in (*row_filters, *((row_filter,) if row_filter else ())):
        if name not in effective:
            effective.append(name)
    return effective


# Aggregations that operate on a measure column. ``count`` is the only one that
# does not — it counts rows and needs no column.
_AGGREGATIONS_REQUIRING_MEASURE = frozenset(
    {
        MetricAggregation.sum,
        MetricAggregation.avg,
        MetricAggregation.min,
        MetricAggregation.max,
    }
)

# Compositions a ``fact`` metric supports. ``per_distinct_user`` is an
# event_composition-only operator and is rejected for ``fact``.
_FACT_COMPOSITIONS = frozenset({MetricComposition.single, MetricComposition.ratio})

FactConditionOperator = Literal[
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "contains",
    "not_contains",
    "like",
    "not_like",
    "in",
    "not_in",
    "is_null",
    "is_not_null",
    "is_true",
    "is_false",
]
FactConditionString = Annotated[str, Field(max_length=4096)]
FactConditionScalar = FactConditionString | int | float | bool
FactConditionList = Annotated[list[FactConditionScalar], Field(max_length=100)]
FactConditionValue = FactConditionScalar | FactConditionList | None

_CONDITION_VALUELESS_OPERATORS = frozenset({"is_null", "is_not_null", "is_true", "is_false"})
_CONDITION_MULTI_VALUE_OPERATORS = frozenset({"in", "not_in"})


def _validate_fact_operand_columns(
    *,
    aggregation: MetricAggregation,
    measure_column: str | None,
    distinct_column: str | None,
    role: str,
) -> None:
    """Enforce the per-aggregation column requirements of one fact operand.

    ``count`` needs no column; ``sum``/``avg``/``min``/``max`` REQUIRE a
    ``measure_column``; ``count_distinct`` REQUIRES a ``distinct_column``. Raises
    ``ValueError`` (English) naming the operand role on any violation.
    """
    if aggregation in _AGGREGATIONS_REQUIRING_MEASURE and not measure_column:
        msg = f"{role}: measure_column is required for aggregation '{aggregation.value}'"
        raise ValueError(msg)
    if aggregation is MetricAggregation.count_distinct and not distinct_column:
        msg = f"{role}: distinct_column is required for aggregation 'count_distinct'"
        raise ValueError(msg)


class FactCondition(BaseModel):
    """One visual fact-row condition compiled into an ANDed SQL filter."""

    model_config = ConfigDict(extra="forbid")

    column: str = Field(min_length=1, max_length=255)
    operator: FactConditionOperator
    value: FactConditionValue = None

    @field_validator("column")
    @classmethod
    def _check_column(cls, value: str) -> str:
        return validate_identifier(value)

    @model_validator(mode="after")
    def validate_condition(self) -> FactCondition:
        if self.operator in _CONDITION_VALUELESS_OPERATORS:
            if self.value not in (None, ""):
                raise ValueError(f"{self.operator}: value must be omitted")
            return self

        if self.value is None:
            raise ValueError(f"{self.operator}: value is required")

        if self.operator in _CONDITION_MULTI_VALUE_OPERATORS:
            values = self.value if isinstance(self.value, list) else [self.value]
            if not values:
                raise ValueError(f"{self.operator}: at least one value is required")
            for value in values:
                if isinstance(value, str) and not value.strip():
                    raise ValueError(f"{self.operator}: values must not be empty")
            return self

        if isinstance(self.value, list):
            raise ValueError(f"{self.operator}: value must be scalar")
        if isinstance(self.value, str) and not self.value.strip():
            raise ValueError(f"{self.operator}: value must not be empty")
        return self

    def to_config(self) -> dict[str, object]:
        data = self.model_dump(mode="json", exclude_none=True)
        if self.operator in _CONDITION_VALUELESS_OPERATORS:
            data.pop("value", None)
        return data


def _conditions_to_config(conditions: list[FactCondition]) -> list[dict[str, object]]:
    return [condition.to_config() for condition in conditions]


# ── Kind-specific config payloads ────────────────────────────────────────────


class FactOperand(BaseModel):
    """One fact-table aggregation operand (a single metric, or one ratio side).

    References a ``FactTable`` by id and aggregates one of its introspected
    columns. ``measure_column`` / ``distinct_column`` reach warehouse SQL
    unparameterised, so they are identifier-validated here; their membership in
    the referenced fact table's columns is checked in the service (it needs the
    DB).

    Row filtering combines three inputs, ANDed together at collection time:
    ``row_filters`` is a list of NAMES of that fact table's stored row filters
    (each resolved to its SQL fragment; membership checked in the service), and
    ``filter_sql`` is a free-text boolean WHERE fragment (SQL-safety-validated
    here). ``conditions`` is a list of visual column/operator/value conditions.
    The legacy single ``row_filter`` name is still accepted on input and folded
    into the effective named-filter set; new writes use ``row_filters`` +
    ``filter_sql`` + ``conditions``.
    """

    model_config = ConfigDict(extra="forbid")

    fact_table_id: uuid.UUID
    aggregation: MetricAggregation
    measure_column: str | None = Field(default=None, min_length=1, max_length=255)
    distinct_column: str | None = Field(default=None, min_length=1, max_length=255)
    # Legacy single named filter — accepted on input for back-compat, folded into
    # ``row_filters`` by ``effective_row_filters`` / ``to_config``.
    row_filter: str | None = Field(default=None, min_length=1, max_length=255)
    # Names of named filters defined on this operand's fact table; ALL are ANDed.
    row_filters: list[str] = Field(default_factory=list, max_length=100)
    # Free-text boolean WHERE fragment, ANDed with the named filters.
    filter_sql: str | None = Field(default=None, min_length=1, max_length=32768)
    # Visual column/operator/value rows, ANDed with named filters + filter_sql.
    conditions: list[FactCondition] = Field(default_factory=list, max_length=100)

    @field_validator("measure_column", "distinct_column")
    @classmethod
    def _check_identifier_fields(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)

    @field_validator("row_filters")
    @classmethod
    def _check_row_filters(cls, value: list[str]) -> list[str]:
        return _validate_row_filter_names(value)

    @field_validator("filter_sql")
    @classmethod
    def _check_filter_sql(cls, value: str | None) -> str | None:
        return _validate_optional_filter_sql(value)

    @model_validator(mode="after")
    def validate_operand(self) -> FactOperand:
        _validate_fact_operand_columns(
            aggregation=self.aggregation,
            measure_column=self.measure_column,
            distinct_column=self.distinct_column,
            role="operand",
        )
        return self

    def effective_row_filters(self) -> list[str]:
        """The effective named-filter set (``row_filters`` + folded legacy name)."""
        return _fold_row_filters(self.row_filters, self.row_filter)

    def to_config(self) -> dict[str, object]:
        """JSON-safe operand dict for the metric ``config`` column."""
        return {
            "fact_table_id": str(self.fact_table_id),
            "aggregation": self.aggregation.value,
            "measure_column": self.measure_column,
            "distinct_column": self.distinct_column,
            "row_filters": self.effective_row_filters(),
            "filter_sql": self.filter_sql,
            "conditions": _conditions_to_config(self.conditions),
        }


class SqlConfig(BaseModel):
    """Config JSON for a ``sql`` metric: a user-authored per-bucket SELECT/CTE."""

    model_config = ConfigDict(extra="forbid")

    metric_sql: str = Field(min_length=1)
    time_column: str = Field(min_length=1, max_length=255)
    # Which projected column carries the measure. None keeps the documented
    # ``value`` convention (tripl-0l0p elevated this from convention to config).
    value_column: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("metric_sql")
    @classmethod
    def _check_metric_sql(cls, value: str) -> str:
        return validate_select_sql_safety(value)

    @field_validator("time_column")
    @classmethod
    def _check_time_column(cls, value: str) -> str:
        return validate_identifier(value)

    @field_validator("value_column")
    @classmethod
    def _check_value_column(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)


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


# ── Kind-specific definition variants (kind + collection config) ─────────────
# Each variant holds ONLY a metric's kind, collection binding and kind-specific
# config — the identity/config columns recomputed on BOTH create and update.
# ``to_definition_values()`` returns exactly those columns. The create variants
# below mix these with the shared presentation fields; the update surface
# (``MetricDefinitionConfigUpdate``) reuses them verbatim, minus the immutable
# internal ``name`` and the other presentation fields (which keep their own
# top-level update fields). Validation is therefore defined ONCE here.


class FactMetricDefinition(BaseModel):
    """Kind + collection config for a ``fact`` metric.

    SINGLE (``composition=single``, the default): one operand given by the
    top-level ``fact_table_id`` + ``aggregation`` + the ``measure_column`` /
    ``distinct_column`` / ``row_filters`` / ``filter_sql`` / ``conditions``
    config fields (the legacy single ``row_filter`` name is still accepted and
    folded in).

    RATIO (``composition=ratio``): ``numerator`` / ``denominator`` operands (each
    a :class:`FactOperand`); the denominator MAY reference a different fact table.
    The numerator operand is mirrored onto the model's ``fact_table_id`` /
    ``aggregation`` columns for catalog display and FK integrity.

    The data source and timestamp column are taken from the referenced fact
    table(s) at collection time; only the collection ``interval`` lives here.
    Fact-table existence, project ownership, column membership, condition-column
    membership, and row-filter name resolution are checked in the service (they
    need the DB).
    """

    kind: Literal[MetricKind.fact] = MetricKind.fact
    composition: MetricComposition = MetricComposition.single
    interval: ScanInterval
    replay_chunk_interval: ScanInterval | None = None

    # SINGLE operand (reuses the model's fact_table_id / aggregation columns).
    fact_table_id: uuid.UUID | None = None
    aggregation: MetricAggregation | None = None
    measure_column: str | None = Field(default=None, min_length=1, max_length=255)
    distinct_column: str | None = Field(default=None, min_length=1, max_length=255)
    # Legacy single named filter — accepted on input for back-compat, folded into
    # ``row_filters`` by ``effective_row_filters`` / ``to_definition_values``.
    row_filter: str | None = Field(default=None, min_length=1, max_length=255)
    # Names of named filters on the fact table (ALL ANDed) + a free-text WHERE.
    row_filters: list[str] = Field(default_factory=list, max_length=100)
    filter_sql: str | None = Field(default=None, min_length=1, max_length=32768)
    conditions: list[FactCondition] = Field(default_factory=list, max_length=100)

    # RATIO operands.
    numerator: FactOperand | None = None
    denominator: FactOperand | None = None

    @field_validator("measure_column", "distinct_column")
    @classmethod
    def _check_single_identifier_fields(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)

    @field_validator("row_filters")
    @classmethod
    def _check_single_row_filters(cls, value: list[str]) -> list[str]:
        return _validate_row_filter_names(value)

    @field_validator("filter_sql")
    @classmethod
    def _check_single_filter_sql(cls, value: str | None) -> str | None:
        return _validate_optional_filter_sql(value)

    def effective_row_filters(self) -> list[str]:
        """The effective named-filter set for the single operand."""
        return _fold_row_filters(self.row_filters, self.row_filter)

    @model_validator(mode="after")
    def validate_kind(self) -> FactMetricDefinition:
        if self.composition not in _FACT_COMPOSITIONS:
            raise ValueError(
                f"fact metric composition must be 'single' or 'ratio', got "
                f"'{self.composition.value}'"
            )
        if self.composition is MetricComposition.single:
            self._validate_single()
        else:
            self._validate_ratio()
        check_replay_chunk_against_interval(
            interval=self.interval,
            replay_chunk_interval=self.replay_chunk_interval,
        )
        return self

    def _validate_single(self) -> None:
        if self.numerator is not None or self.denominator is not None:
            raise ValueError("single fact metric must not set numerator/denominator operands")
        if self.fact_table_id is None or self.aggregation is None:
            raise ValueError("single fact metric requires fact_table_id and aggregation")
        _validate_fact_operand_columns(
            aggregation=self.aggregation,
            measure_column=self.measure_column,
            distinct_column=self.distinct_column,
            role="single",
        )

    def _validate_ratio(self) -> None:
        if self.numerator is None or self.denominator is None:
            raise ValueError("ratio fact metric requires both numerator and denominator operands")
        if (
            self.fact_table_id is not None
            or self.aggregation is not None
            or self.measure_column is not None
            or self.distinct_column is not None
            or self.row_filter is not None
            or self.row_filters
            or self.filter_sql is not None
            or self.conditions
        ):
            raise ValueError(
                "ratio fact metric must not set top-level single-operand fields; "
                "use numerator/denominator"
            )

    def to_definition_values(self) -> dict[str, object]:
        if self.composition is MetricComposition.single:
            fact_table_id = self.fact_table_id
            aggregation = self.aggregation
            config: dict[str, object] = {
                "measure_column": self.measure_column,
                "distinct_column": self.distinct_column,
                "row_filters": self.effective_row_filters(),
                "filter_sql": self.filter_sql,
                "conditions": _conditions_to_config(self.conditions),
            }
        else:
            if self.numerator is None or self.denominator is None:
                raise ValueError("ratio fact metric requires both numerator and denominator")
            fact_table_id = self.numerator.fact_table_id
            aggregation = self.numerator.aggregation
            config = {
                "numerator": self.numerator.to_config(),
                "denominator": self.denominator.to_config(),
            }
        return {
            "kind": self.kind,
            "aggregation": aggregation,
            "composition": self.composition,
            "config": config,
            "fact_table_id": fact_table_id,
            "data_source_id": None,
            "interval": self.interval,
            "replay_chunk_interval": self.replay_chunk_interval,
            "numerator_event_id": None,
            "numerator_event_type_id": None,
            "denominator_event_id": None,
            "denominator_event_type_id": None,
        }


class SqlMetricDefinition(BaseModel):
    """Kind + collection config for a ``sql`` metric: SELECT + its data source."""

    kind: Literal[MetricKind.sql] = MetricKind.sql
    config: SqlConfig
    data_source_id: uuid.UUID
    interval: ScanInterval
    replay_chunk_interval: ScanInterval | None = None

    @model_validator(mode="after")
    def validate_kind(self) -> SqlMetricDefinition:
        check_replay_chunk_against_interval(
            interval=self.interval,
            replay_chunk_interval=self.replay_chunk_interval,
        )
        return self

    def to_definition_values(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "aggregation": None,
            "composition": None,
            "config": self.config.model_dump(),
            "fact_table_id": None,
            "data_source_id": self.data_source_id,
            "interval": self.interval,
            "replay_chunk_interval": self.replay_chunk_interval,
            "numerator_event_id": None,
            "numerator_event_type_id": None,
            "denominator_event_id": None,
            "denominator_event_type_id": None,
        }


class EventCompositionMetricDefinition(BaseModel):
    """Kind + config for an ``event_composition`` metric; no data source / interval.

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
    # per_distinct_user denominator column; None keeps the documented
    # ``user_id`` default. The collector already honored this config key —
    # the schema layer just used to drop it (tripl-0l0p).
    user_id_column: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("user_id_column")
    @classmethod
    def _check_user_id_column(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)

    @model_validator(mode="after")
    def validate_kind(self) -> EventCompositionMetricDefinition:
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
        if (
            self.user_id_column is not None
            and self.composition != MetricComposition.per_distinct_user
        ):
            msg = "user_id_column only applies to per_distinct_user composition"
            raise ValueError(msg)
        return self

    def to_definition_values(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "aggregation": None,
            "composition": self.composition,
            "config": (
                {"user_id_column": self.user_id_column} if self.user_id_column is not None else {}
            ),
            "fact_table_id": None,
            "data_source_id": None,
            "interval": None,
            "replay_chunk_interval": None,
            "numerator_event_id": self.numerator_event_id,
            "numerator_event_type_id": self.numerator_event_type_id,
            "denominator_event_id": self.denominator_event_id,
            "denominator_event_type_id": self.denominator_event_type_id,
        }


# ── Discriminated create variants (presentation + definition) ────────────────
# Each create variant = shared presentation fields + one kind definition. The
# full create row is the union of both halves.


class FactMetricCreate(_MetricDefinitionBase, FactMetricDefinition):
    def to_create_values(self) -> dict[str, object]:
        return {**self._shared_values(), **self.to_definition_values()}


class SqlMetricCreate(_MetricDefinitionBase, SqlMetricDefinition):
    def to_create_values(self) -> dict[str, object]:
        return {**self._shared_values(), **self.to_definition_values()}


class EventCompositionMetricCreate(_MetricDefinitionBase, EventCompositionMetricDefinition):
    def to_create_values(self) -> dict[str, object]:
        return {**self._shared_values(), **self.to_definition_values()}


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
    FactMetricCreate | SqlMetricCreate | EventCompositionMetricCreate,
    Field(discriminator="kind"),
]


# The kind + collection definition accepted on UPDATE: the same discriminated
# union as create, minus the presentation fields (which keep their own top-level
# update fields) and minus the immutable internal ``name``. Re-validated with the
# exact create-time logic; the service overwrites the identity/config columns
# from ``to_definition_values()``.
MetricDefinitionConfigUpdate = Annotated[
    FactMetricDefinition | SqlMetricDefinition | EventCompositionMetricDefinition,
    Field(discriminator="kind"),
]


# ── Update / bulk ────────────────────────────────────────────────────────────


class MetricDefinitionUpdate(BaseModel):
    """Partial update of presentation, lifecycle, dimension and monitoring fields,
    plus an optional ``definition`` block that re-defines the metric's kind +
    collection config.

    The internal ``name`` is the stable query identifier and stays IMMUTABLE: it
    has no update field and is ignored if supplied. The optional ``definition``
    block mirrors the create discriminated union (minus ``name`` and the other
    presentation fields, which keep their own update fields here); when present it
    is re-validated EXACTLY like creation and the service overwrites the metric's
    ``kind`` / ``config`` / collection binding from it. A ``kind`` change clears
    the metric's previously collected values (see the service).
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
    definition: MetricDefinitionConfigUpdate | None = None

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
    fact_table_id: uuid.UUID | None
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


class MetricDefinitionDetailResponse(MetricDefinitionResponse):
    """Metric detail plus exact read-time scheduler state."""

    # ``None`` means draft/archived/event-composition/no interval.
    next_collection_at: datetime | None = None
    collection_due: bool = False


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


class MetricPreviewRequest(BaseModel):
    """Stateless dry-run of a ``sql``-kind metric SELECT (nothing is persisted).

    SQL semantics (read-only shape, projected columns, identifier validity) are
    deliberately NOT validated at this schema boundary: those are expected user
    mistakes while drafting a query, and the preview endpoint reports them as a
    200 response with ``error`` set (see ``metric_preview_service``) instead of
    a 422. Only structural shape (types, lengths, interval enum) is enforced
    here.
    """

    data_source_id: uuid.UUID
    sql: str = Field(min_length=1)
    time_column: str = Field(min_length=1, max_length=255)
    # None keeps the documented ``value`` convention (same default as SqlConfig).
    value_column: str | None = Field(default=None, min_length=1, max_length=255)
    interval: ScanInterval


class FactOperandPreviewResponse(BaseModel):
    """Dry-run outcome for ONE fact operand's compiled row filter.

    The request body is the operand itself (:class:`FactOperand`) — the same
    payload a save sends — so the preview compiles from the identical config the
    worker will later read. ``columns`` / ``row_count`` describe the filtered
    fact query the operand aggregates (probed with a 1-row cap); expected user
    mistakes — an unknown named filter, a filter the warehouse rejects, a measure
    column the filtered query does not project — come back with ``error`` set on
    a 200 (see ``metric_preview_service.preview_fact_operand``), not a 5xx.
    """

    columns: list[str] = Field(default_factory=list)
    row_count: int = 0
    error: str | None = None


class MetricPreviewPoint(BaseModel):
    """One interval-floored (bucket, value) preview point."""

    bucket: datetime
    value: float


class MetricPreviewResponse(BaseModel):
    """Preview outcome; user-level failures set ``error`` with empty ``points``."""

    columns: list[str] = Field(default_factory=list)
    points: list[MetricPreviewPoint] = Field(default_factory=list)
    point_count: int = 0
    truncated: bool = False
    error: str | None = None


class MetricCollectNowResponse(BaseModel):
    """202 payload for a manual ``POST /metrics/{id}/collect`` trigger.

    ``window_from`` / ``window_to`` describe the backfilled [from, to) window for
    ``fact`` / ``sql`` metrics; they are ``None`` for ``event_composition``
    metrics, which have no interval and recompute from the full event-metric
    series. ``task_id`` is the dispatched Celery task id when the broker returns
    one, else ``None``. For a fact metric the task is a shared dependency batch:
    the response window describes the clicked metric, while each
    different-interval dependent receives its own bounded window in that task.
    ``metric_count`` is how many metrics that batch refreshes (1 for a metric
    with no active siblings), so a click can say what it set in motion instead of
    silently refreshing a dozen other metrics.
    """

    metric_id: uuid.UUID
    status: Literal["queued"] = "queued"
    window_from: datetime | None = None
    window_to: datetime | None = None
    task_id: str | None = None
    metric_count: int = 1


class MetricGeneratedSqlQuery(BaseModel):
    """One executable primary query from the shared fact-collection batch.

    A batch is grouped by interval and fact table, then optionally split into
    bounded replay chunks. ``metric_ids`` names the dependency-group metrics
    whose aggregate specs are folded into this statement. Breakdown scans are a
    separate path and are explicitly excluded by the response flag below.
    """

    role: Literal["primary"] = "primary"
    label: str
    fact_table_id: uuid.UUID
    fact_table_name: str
    interval: str
    window_from: datetime
    window_to: datetime
    metric_ids: list[uuid.UUID]
    sql: str


class MetricGeneratedSqlResponse(BaseModel):
    queries: list[MetricGeneratedSqlQuery]
    breakdown_queries_omitted: bool = True
