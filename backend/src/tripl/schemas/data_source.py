import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from tripl.models.data_source import DBType, TestStatus

# ClickHouse JSON path *discovery* (preview) mode. "dynamic" enumerates only the
# important typed subcolumn paths (JSONDynamicPaths, fast); "all" enumerates every
# path (JSONAllPaths). NULL means "use the connection default" (dynamic).
JsonPathDiscovery = Literal["all", "dynamic"]

# Bare hostname / IPv4 / bracketed IPv6 characters. Format-only guard: we do NOT
# block private/loopback addresses here on purpose — data sources legitimately
# point at private DBs (RFC1918 / VPC) and localhost. This only rejects values
# that are clearly not a host (a full URL, a path, or embedded whitespace).
_HOST_FORMAT_RE = re.compile(r"^[A-Za-z0-9._:\-\[\]]+$")


def _validate_host_format(value: str | None) -> str | None:
    if value is None:
        return value
    trimmed = value.strip()
    if "://" in trimmed or "/" in trimmed or any(ch.isspace() for ch in trimmed):
        raise ValueError(
            "host must be a bare hostname or IP address (no scheme, path, or whitespace)"
        )
    if not _HOST_FORMAT_RE.match(trimmed):
        raise ValueError("host contains invalid characters")
    return trimmed


class DataSourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    db_type: DBType
    host: str = Field(min_length=1, max_length=500)
    port: int = Field(default=8123, ge=1, le=65535)
    database_name: str = Field(min_length=1, max_length=255)
    username: str = ""
    password: str = ""
    timeout_seconds: int | None = Field(None, ge=1)
    json_path_discovery: JsonPathDiscovery | None = None
    extra_params: dict[str, object] | None = None

    @field_validator("host")
    @classmethod
    def _check_host(cls, value: str) -> str:
        validated = _validate_host_format(value)
        assert validated is not None  # host is required on create
        return validated


class DataSourceUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    db_type: DBType | None = None
    host: str | None = Field(None, min_length=1, max_length=500)
    port: int | None = Field(None, ge=1, le=65535)
    database_name: str | None = Field(None, min_length=1, max_length=255)
    username: str | None = None
    password: str | None = None
    timeout_seconds: int | None = Field(None, ge=1)
    json_path_discovery: JsonPathDiscovery | None = None
    extra_params: dict[str, object] | None = None

    @field_validator("host")
    @classmethod
    def _check_host(cls, value: str | None) -> str | None:
        return _validate_host_format(value)


class DataSourceResponse(BaseModel):
    id: uuid.UUID
    name: str
    db_type: DBType
    host: str
    port: int
    database_name: str
    username: str
    password_set: bool
    timeout_seconds: int | None = None
    json_path_discovery: JsonPathDiscovery | None = None
    extra_params: dict[str, object] | None
    last_test_at: datetime | None
    last_test_status: TestStatus | None
    last_test_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DataSourceTestResponse(BaseModel):
    success: bool
    message: str
    tested_at: datetime
    data_source: DataSourceResponse


class DataSourceThroughputPoint(BaseModel):
    bucket: datetime
    count: int


class DataSourceStatsResponse(BaseModel):
    """Runtime activity for a data source, aggregated from EventMetric rollups."""

    events_tracked: int
    volume_window: int
    window_hours: int
    throughput: list[DataSourceThroughputPoint]
