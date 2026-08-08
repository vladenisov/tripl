import re
import uuid
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from tripl.core.adapters.measure_validator import validate_select_sql_safety
from tripl.core.intervals import get_interval
from tripl.json_paths import normalize_json_value_paths
from tripl.models.domain_enums import ScanInterval
from tripl.models.scan_job import ScanJobStatus


class EventGroupCondition(BaseModel):
    field: str = Field(min_length=1, max_length=255)
    pattern: str = Field(min_length=1, max_length=500)

    @field_validator("field", "pattern")
    @classmethod
    def strip_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("value cannot be blank")
        return stripped

    @field_validator("pattern")
    @classmethod
    def validate_regex(cls, value: str) -> str:
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"invalid regex pattern: {exc}") from exc
        return value


class EventGroupRule(BaseModel):
    name: str = Field(min_length=1, max_length=500)
    condition_logic: Literal["all", "any"] = "all"
    conditions: list[EventGroupCondition] = Field(min_length=1, max_length=20)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("name cannot be blank")
        return stripped


def check_scalar_columns_unreserved(
    *,
    metric_breakdown_columns: list[str],
    distribution_drift_fields: list[str],
    event_type_column: str | None,
    time_column: str | None,
    app_version_column: str | None = None,
    platform_column: str | None = None,
) -> None:
    """Reject selections that overlap reserved time/grouping/version/platform columns.

    Used by both ScanConfigCreate (full payload) and the scan service
    update path (merged payload). Raises ValueError so pydantic surfaces it
    as 422 directly; the service-layer catches it to convert to HTTPException.

    ``app_version_column`` and ``platform_column`` are reserved because, when set,
    each is collected on its own path; letting either double as a generic
    breakdown or drift column would collect it twice. The platform column is also
    barred from coinciding with the other reserved roles.
    """
    reserved = {
        column
        for column in (event_type_column, time_column, app_version_column, platform_column)
        if column
    }
    if set(metric_breakdown_columns) & reserved:
        raise ValueError(
            "metric_breakdown_columns cannot include event_type_column, time_column, "
            "app_version_column or platform_column"
        )
    if set(distribution_drift_fields) & reserved:
        raise ValueError(
            "distribution_drift_fields cannot include event_type_column, time_column, "
            "app_version_column or platform_column"
        )
    other_roles = {
        column for column in (event_type_column, time_column, app_version_column) if column
    }
    if platform_column and platform_column in other_roles:
        raise ValueError(
            "platform_column cannot also be event_type_column, time_column or app_version_column"
        )


def check_replay_chunk_against_interval(
    *,
    interval: str | None,
    replay_chunk_interval: str | None,
) -> None:
    """A replay chunk cannot be finer than the collection interval (you can't
    split a window below one bucket). NULL chunk means "no split" and is allowed
    regardless of interval."""
    if replay_chunk_interval is None:
        return
    if interval is None:
        raise ValueError("replay_chunk_interval requires a collection interval")
    if get_interval(replay_chunk_interval).delta < get_interval(interval).delta:
        raise ValueError("replay_chunk_interval must be greater than or equal to interval")


class ScanConfigCreate(BaseModel):
    data_source_id: uuid.UUID
    event_type_id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=255)
    base_query: str = Field(min_length=1)
    event_type_column: str | None = None
    time_column: str | None = None
    event_name_format: str | None = None
    json_value_paths: list[str] = Field(default_factory=list)
    event_group_rules: list[EventGroupRule] = Field(default_factory=list)
    metric_breakdown_columns: list[str] = Field(default_factory=list)
    metric_breakdown_values_limit: int | None = Field(default=None, ge=1)
    distribution_drift_fields: list[str] = Field(default_factory=list)
    cardinality_threshold: int = Field(default=100, ge=1)
    interval: ScanInterval | None = None
    replay_chunk_interval: ScanInterval | None = None
    scan_lookback_hours: int | None = Field(default=None, ge=1)
    scan_row_limit: int | None = Field(default=None, ge=1)
    metrics_row_limit: int | None = Field(default=None, ge=1)
    app_version_column: str | None = Field(default=None, min_length=1, max_length=255)
    app_version_keep_releases: int | None = Field(
        default=None,
        ge=1,
        deprecated=True,
        description=(
            "Deprecated compatibility mirror of Project.app_version_keep_releases; "
            "caller values are ignored."
        ),
    )
    app_version_prerelease_pattern: str | None = Field(default=None, min_length=1, max_length=255)
    app_version_active_share_min: float | None = Field(default=None, gt=0.0, lt=1.0)
    platform_column: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("base_query")
    @classmethod
    def validate_base_query(cls, value: str) -> str:
        return validate_select_sql_safety(value)

    @field_validator("json_value_paths")
    @classmethod
    def validate_json_value_paths(cls, value: list[str]) -> list[str]:
        normalized = normalize_json_value_paths(value)
        invalid = sorted(set(value) - set(normalized))
        if invalid:
            raise ValueError("json_value_paths must use <json_column>.<nested.path> format")
        return normalized

    @field_validator("metric_breakdown_columns")
    @classmethod
    def validate_metric_breakdown_columns(cls, value: list[str]) -> list[str]:
        return _normalize_scalar_columns(
            value,
            field_name="metric_breakdown_columns",
        )

    @field_validator("distribution_drift_fields")
    @classmethod
    def validate_distribution_drift_fields(cls, value: list[str]) -> list[str]:
        return _normalize_scalar_columns(
            value,
            field_name="distribution_drift_fields",
        )

    @model_validator(mode="after")
    def validate_monitoring_selection(self) -> ScanConfigCreate:
        check_scalar_columns_unreserved(
            metric_breakdown_columns=self.metric_breakdown_columns,
            distribution_drift_fields=self.distribution_drift_fields,
            event_type_column=self.event_type_column,
            time_column=self.time_column,
            app_version_column=self.app_version_column,
            platform_column=self.platform_column,
        )
        check_replay_chunk_against_interval(
            interval=self.interval,
            replay_chunk_interval=self.replay_chunk_interval,
        )
        return self


def _normalize_scalar_columns(value: list[str], *, field_name: str) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for item in value:
        column = item.strip()
        if not column:
            continue
        if "." in column:
            raise ValueError(f"{field_name} supports scalar columns only")
        if column not in seen:
            normalized.append(column)
            seen.add(column)
    return normalized


class ScanConfigUpdate(BaseModel):
    event_type_id: uuid.UUID | None = None
    name: str | None = Field(None, min_length=1, max_length=255)
    base_query: str | None = Field(None, min_length=1)
    event_type_column: str | None = None
    time_column: str | None = None
    event_name_format: str | None = None
    json_value_paths: list[str] | None = None
    event_group_rules: list[EventGroupRule] | None = None
    metric_breakdown_columns: list[str] | None = None
    metric_breakdown_values_limit: int | None = Field(default=None, ge=1)
    distribution_drift_fields: list[str] | None = None
    cardinality_threshold: int | None = Field(None, ge=1)
    interval: ScanInterval | None = None
    replay_chunk_interval: ScanInterval | None = None
    scan_lookback_hours: int | None = Field(default=None, ge=1)
    scan_row_limit: int | None = Field(default=None, ge=1)
    metrics_row_limit: int | None = Field(default=None, ge=1)
    app_version_column: str | None = Field(default=None, max_length=255)
    app_version_keep_releases: int | None = Field(
        default=None,
        ge=1,
        deprecated=True,
        description=(
            "Deprecated compatibility mirror of Project.app_version_keep_releases; "
            "caller values are ignored."
        ),
    )
    app_version_prerelease_pattern: str | None = Field(default=None, max_length=255)
    app_version_active_share_min: float | None = Field(default=None, gt=0.0, lt=1.0)
    platform_column: str | None = Field(default=None, max_length=255)

    @field_validator("base_query")
    @classmethod
    def validate_base_query(cls, value: str | None) -> str | None:
        return value if value is None else validate_select_sql_safety(value)

    @field_validator("json_value_paths")
    @classmethod
    def validate_json_value_paths(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        normalized = normalize_json_value_paths(value)
        invalid = sorted(set(value) - set(normalized))
        if invalid:
            raise ValueError("json_value_paths must use <json_column>.<nested.path> format")
        return normalized

    @field_validator("metric_breakdown_columns")
    @classmethod
    def validate_metric_breakdown_columns(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_scalar_columns(value, field_name="metric_breakdown_columns")

    @field_validator("distribution_drift_fields")
    @classmethod
    def validate_distribution_drift_fields(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_scalar_columns(value, field_name="distribution_drift_fields")


class ScanConfigResponse(BaseModel):
    id: uuid.UUID
    data_source_id: uuid.UUID
    project_id: uuid.UUID
    event_type_id: uuid.UUID | None
    name: str
    base_query: str
    event_type_column: str | None
    time_column: str | None
    event_name_format: str | None
    json_value_paths: list[str]
    event_group_rules: list[EventGroupRule]
    metric_breakdown_columns: list[str]
    metric_breakdown_values_limit: int | None
    distribution_drift_fields: list[str]
    cardinality_threshold: int
    interval: ScanInterval | None
    replay_chunk_interval: ScanInterval | None
    scan_lookback_hours: int | None
    scan_row_limit: int | None
    metrics_row_limit: int | None
    app_version_column: str | None
    app_version_keep_releases: int | None = Field(
        deprecated=True,
        description="Deprecated compatibility mirror of Project.app_version_keep_releases.",
    )
    app_version_prerelease_pattern: str | None
    app_version_active_share_min: float | None
    platform_column: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ScanPreviewColumnResponse(BaseModel):
    name: str
    type_name: str
    is_nullable: bool


class ScanPreviewJsonPathResponse(BaseModel):
    full_path: str
    path: str
    sample_values: list[str]


class ScanPreviewJsonColumnResponse(BaseModel):
    column: str
    paths: list[ScanPreviewJsonPathResponse]


class ScanConfigPreviewRequest(BaseModel):
    data_source_id: uuid.UUID
    base_query: str = Field(min_length=1)
    limit: int = Field(default=10, ge=1, le=50)
    json_value_paths: list[str] = Field(default_factory=list)
    time_column: str | None = Field(default=None, min_length=1, max_length=255)
    scan_lookback_hours: int | None = Field(default=None, ge=1)
    # When true, run the slow JSON path discovery instead of the fast preview.
    include_json_paths: bool = False

    @field_validator("base_query")
    @classmethod
    def validate_base_query(cls, value: str) -> str:
        return validate_select_sql_safety(value)

    @field_validator("json_value_paths")
    @classmethod
    def validate_json_value_paths(cls, value: list[str]) -> list[str]:
        normalized = normalize_json_value_paths(value)
        invalid = sorted(set(value) - set(normalized))
        if invalid:
            raise ValueError("json_value_paths must use <json_column>.<nested.path> format")
        return normalized


class ScanConfigPreviewResponse(BaseModel):
    columns: list[ScanPreviewColumnResponse]
    rows: list[dict[str, object]]
    json_columns: list[ScanPreviewJsonColumnResponse]


class ScanDryRunRequest(BaseModel):
    """Inputs for "what would this scan create?".

    Two shapes, and exactly one of them must be supplied. The scan form has no
    saved config, so it sends the draft — that is the only shape the UI sends.
    ``scan_config_id`` is the API/agent shape (``integrate/agent-api-guide.md``):
    a caller that already has a stored config asks about it by id instead of
    re-serialising twenty fields it did not author, and every draft field below
    is then ignored. Nothing in the frontend uses it today; it is a documented
    capability of the HTTP API, not unfinished UI.
    """

    scan_config_id: uuid.UUID | None = None
    data_source_id: uuid.UUID | None = None
    base_query: str | None = Field(default=None, min_length=1)
    event_type_id: uuid.UUID | None = None
    event_type_column: str | None = None
    time_column: str | None = None
    event_name_format: str | None = None
    event_group_rules: list[EventGroupRule] = Field(default_factory=list)
    json_value_paths: list[str] = Field(default_factory=list)
    cardinality_threshold: int = Field(default=100, ge=1)
    app_version_column: str | None = Field(default=None, min_length=1, max_length=255)
    platform_column: str | None = Field(default=None, min_length=1, max_length=255)
    scan_lookback_hours: int | None = Field(default=None, ge=1)
    # How many breakdown combinations the dry-run may examine. Bounded at both
    # ends: below 100 the answer is noise, above 20000 it is a production scan.
    sample_row_limit: int = Field(default=5000, ge=100, le=20000)

    @field_validator("base_query")
    @classmethod
    def validate_base_query(cls, value: str | None) -> str | None:
        # The same gate ScanConfigCreate applies. Reused, never re-implemented:
        # this endpoint executes free-text SQL against a stored credential.
        return value if value is None else validate_select_sql_safety(value)

    @field_validator("json_value_paths")
    @classmethod
    def validate_json_value_paths(cls, value: list[str]) -> list[str]:
        normalized = normalize_json_value_paths(value)
        invalid = sorted(set(value) - set(normalized))
        if invalid:
            raise ValueError("json_value_paths must use <json_column>.<nested.path> format")
        return normalized

    @model_validator(mode="after")
    def validate_target(self) -> ScanDryRunRequest:
        if self.scan_config_id is not None:
            return self
        if self.data_source_id is None or not self.base_query:
            raise ValueError(
                "either scan_config_id, or both data_source_id and base_query, must be provided"
            )
        # A draft that names neither is unanswerable, not merely empty: the
        # planner resolves event types exactly the way a real run does, and both
        # abort on this. Rejecting it here turns what was a dispatched job that
        # failed with the worker's internal precondition into a 422 the caller
        # can act on before any warehouse query is issued.
        if self.event_type_id is None and not self.event_type_column:
            # Named after the CONTROLS, not the columns behind them. The worker's
            # sibling message (``_errors.NO_EVENT_NAMING_MSG``) was rewritten the
            # same way in this change, and a 422 body is read by a person — the
            # agent API and the CLI surface it verbatim. "event_type_id" is the
            # exact vocabulary this epic exists to keep off a user's screen.
            raise ValueError(
                "set either Event type or Event type column, so the preview "
                "knows how this scan names its events"
            )
        return self


class ScanDryRunEvent(BaseModel):
    """One event the config would produce, and how much of the sample it is.

    An event is identified by ``(event_type, source_name)``, not by the name
    alone: a run writes one Event per event type, so a grouped scan whose name
    format collapses to the same string under two event types creates two
    Events. Listing them as one would undercount the answer this panel exists to
    give.
    """

    name: str
    source_name: str
    # The event type this event would be written under. On the grouped
    # (``event_type_column``) path this is the group value; with an explicit
    # ``event_type_id`` every row shares the one event type's name.
    event_type: str
    approx_row_count: int
    share_of_sample: float
    # Only two values are emitted. "merged" is carried by ``grouped_by_rule``
    # instead: a grouped event is ALSO either new or already in the plan, and a
    # three-way status would make "N new · M already in your plan" fail to
    # account for every event in the list.
    status: Literal["new", "existing"]
    grouped_by_rule: str | None = None
    count_confidence: Literal["exact", "sampled"]


class ScanDryRunField(BaseModel):
    """A field the config would add to the plan.

    ``type`` is "json" or "string" and nothing else — that is the ENTIRE
    inference the scan performs (``worker.tasks.metrics.generation``). Promising
    integer/timestamp here would be a lie about what the scan creates.
    """

    name: str
    type: Literal["json", "string"]
    status: Literal["new", "exists"]
    event_type: str


class ScanDryRunTemplatedColumn(BaseModel):
    """A column collapsed into a ``${column}`` template by the cardinality rule.

    Surfaced so the user can see WHY they got 3 events instead of 3000 — it is a
    step function of a threshold they are editing in the same form, not a
    property of their data.
    """

    column: str
    distinct_values: int
    threshold: int


class ScanDryRunResponse(BaseModel):
    """What a scan would create, bounded by three separate partialities.

    1. the lookback window (``window_from`` / ``window_to``) — an event absent
       from 24h is not an event that will not be created;
    2. the sample (``sample_is_complete``) — when false the caller must say
       "at least N", never "N";
    3. the event cap (``max_events_reached``) — the real scan stops there too.

    Never extrapolate any of these to a table-wide total. ``share_of_sample``
    exists so the caller does not have to invent one.
    """

    window_from: datetime | None = None
    window_to: datetime | None = None
    # Warehouse rows the examined combinations cover (the sum of each row's
    # ``_cnt``), NOT the number of combinations — that is
    # ``breakdown_combinations``.
    sampled_rows: int = 0
    sample_row_limit: int = 0
    sample_is_complete: bool = True
    breakdown_combinations: int = 0
    events: list[ScanDryRunEvent] = Field(default_factory=list)
    events_truncated: bool = False
    max_events_reached: bool = False
    fields: list[ScanDryRunField] = Field(default_factory=list)
    templated_columns: list[ScanDryRunTemplatedColumn] = Field(default_factory=list)
    reserved_columns: list[str] = Field(default_factory=list)
    unmapped_columns: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    # Name-format failures land here rather than failing the job: catching an
    # unknown-key format in a dry-run, instead of after 200 failed production
    # runs, is the single highest-value thing this endpoint does (tripl-lpin).
    errors: list[str] = Field(default_factory=list)


class ScanDryRunJobResponse(BaseModel):
    id: uuid.UUID
    status: ScanJobStatus
    started_at: datetime | None
    completed_at: datetime | None
    # Typed, unlike ``ScanPreviewJobResponse``'s bare dict: the payload is the
    # whole point of the endpoint, and typing it here is what puts
    # ``ScanDryRunResponse`` in the OpenAPI components so the frontend codegens
    # the shape instead of hand-copying it. Null while pending/running or on
    # failure.
    result_summary: ScanDryRunResponse | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ScanMetricsReplayRequest(BaseModel):
    time_from: datetime
    time_to: datetime

    @field_validator("time_from", "time_to")
    @classmethod
    def normalize_datetime(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    @model_validator(mode="after")
    def validate_window(self) -> ScanMetricsReplayRequest:
        if self.time_from >= self.time_to:
            raise ValueError("time_from must be earlier than time_to")
        return self
