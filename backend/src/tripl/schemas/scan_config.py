import uuid
from datetime import UTC, datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from tripl.json_paths import normalize_json_value_paths

VALID_INTERVALS = ("15m", "1h", "6h", "1d", "1w")


class ScanConfigCreate(BaseModel):
    data_source_id: uuid.UUID
    event_type_id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=255)
    base_query: str = Field(min_length=1)
    event_type_column: str | None = None
    time_column: str | None = None
    event_name_format: str | None = None
    json_value_paths: list[str] = Field(default_factory=list)
    metric_breakdown_columns: list[str] = Field(default_factory=list)
    metric_breakdown_values_limit: int | None = Field(default=None, ge=1)
    distribution_drift_fields: list[str] = Field(default_factory=list)
    cardinality_threshold: int = Field(default=100, ge=1)
    interval: str | None = Field(None, pattern=r"^(15m|1h|6h|1d|1w)$")

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
    metric_breakdown_columns: list[str] | None = None
    metric_breakdown_values_limit: int | None = Field(default=None, ge=1)
    distribution_drift_fields: list[str] | None = None
    cardinality_threshold: int | None = Field(None, ge=1)
    interval: str | None = Field(None, pattern=r"^(15m|1h|6h|1d|1w)$")

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
    metric_breakdown_columns: list[str]
    metric_breakdown_values_limit: int | None
    distribution_drift_fields: list[str]
    cardinality_threshold: int
    interval: str | None
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


class ScanConfigPreviewResponse(BaseModel):
    columns: list[ScanPreviewColumnResponse]
    rows: list[dict[str, object]]
    json_columns: list[ScanPreviewJsonColumnResponse]


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
    def validate_window(self) -> "ScanMetricsReplayRequest":
        if self.time_from >= self.time_to:
            raise ValueError("time_from must be earlier than time_to")
        return self
