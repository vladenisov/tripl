from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator

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


# ---------------------------------------------------------------------------
# Typed, per-warehouse connection settings
# ---------------------------------------------------------------------------
#
# These used to ride in an untyped ``extra_params`` dict: unvalidated, invisible
# in the UI, and silently ignored by the adapter factory for everything except
# BigQuery's ``location``. They are now a strict Pydantic model per warehouse.
#
# Storage: still the existing ``data_sources.extra_params`` JSON column (no
# migration). What changes is that its contents are validated against the model
# for the row's ``db_type`` on every write, so a setting that does not apply to
# the warehouse is REJECTED (422) instead of being silently persisted and
# dropped. ``extra="forbid"`` on every model turns an unknown key into an error
# too.
#
# Secrets: ``PostgresSettings.sslkey`` is a private key. It is a ``SecretStr``
# (so it can never be echoed by a ``model_dump``/audit payload), is stored
# Fernet-encrypted under the ``sslkey_encrypted`` storage key exactly like
# ``password_encrypted``, and is never part of a response model — the response
# only carries ``sslkey_set: bool``.

# psql's sslmode ladder. "prefer" is the server-side default for PostgreSQL:
# it matches libpq's own default and keeps loopback/dev connections working,
# while "require"/"verify-ca"/"verify-full" opt into real TLS enforcement.
PostgresSslMode = Literal["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]

# Storage key for the Fernet-encrypted PostgreSQL client private key. Never the
# plaintext ``sslkey``: the ciphertext is what lands in the JSON column.
SSLKEY_STORAGE_KEY = "sslkey_encrypted"

# Server-side defaults. They deliberately differ per db_type — a BigQuery source
# needs a cost ceiling, a PostgreSQL source needs a TLS posture, and neither is
# meaningful for the other.
DEFAULT_TIMEOUT_SECONDS = 300
# ~100 GiB. A single scan/metric query that would bill more than this is refused
# by BigQuery before it runs, so a stray cross join cannot quietly burn a budget.
DEFAULT_BIGQUERY_MAXIMUM_BYTES_BILLED = 100 * 1024**3

_BQ_LOCATION_RE = re.compile(r"^[A-Za-z0-9-]{2,40}$")
_BQ_DATASET_RE = re.compile(r"^[A-Za-z0-9_]{1,1024}$")
# A comma-separated list of plain SQL identifiers. Interpolated into
# ``SET search_path`` by the adapter, so anything that is not an identifier list
# (quotes, semicolons, whitespace tricks) must not get through.
_SEARCH_PATH_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*(\s*,\s*[A-Za-z_][A-Za-z0-9_$]*)*$")
_MAX_DATASET_ALLOWLIST = 50


def _require_pem(value: str | None, *, label: str) -> str | None:
    """Certificates/keys are passed as PEM *content*, never as a server path.

    A filesystem path would be both useless (the worker container does not have
    the operator's files) and a directory-traversal foot-gun, so reject anything
    that is not a PEM block outright.
    """
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if not trimmed.startswith("-----BEGIN"):
        raise ValueError(
            f"{label} must be the PEM content itself (starting with '-----BEGIN'), not a file path"
        )
    return trimmed


class _ConnectionSettingsBase(BaseModel):
    # The whole point: an unknown key is an error, not a silently stored no-op.
    model_config = ConfigDict(extra="forbid")


class ClickHouseSettings(_ConnectionSettingsBase):
    """ClickHouse has no extra connection settings.

    Its two knobs — ``timeout_seconds`` and ``json_path_discovery`` — are
    first-class columns on the data source, not connection settings.
    """


class SyntheticSettings(_ConnectionSettingsBase):
    """The synthetic (demo) warehouse is in-memory: it has nothing to configure."""


class PostgresSettings(_ConnectionSettingsBase):
    """Typed allowlist of safe PostgreSQL connection options."""

    sslmode: PostgresSslMode | None = None
    sslrootcert: str | None = Field(default=None, max_length=64_000)
    sslcert: str | None = Field(default=None, max_length=64_000)
    # Write-only: a private key. Never returned by the API (see
    # ``ConnectionSettingsResponse.sslkey_set``) and never logged (SecretStr).
    sslkey: SecretStr | None = Field(default=None, max_length=64_000)
    search_path: str | None = Field(default=None, max_length=255)

    @field_validator("sslrootcert")
    @classmethod
    def _check_root_cert(cls, value: str | None) -> str | None:
        return _require_pem(value, label="sslrootcert")

    @field_validator("sslcert")
    @classmethod
    def _check_client_cert(cls, value: str | None) -> str | None:
        return _require_pem(value, label="sslcert")

    @field_validator("sslkey")
    @classmethod
    def _check_client_key(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        secret = value.get_secret_value()
        # An empty key means "clear the stored key" — see the service.
        if not secret.strip():
            return SecretStr("")
        _require_pem(secret, label="sslkey")
        return value

    @field_validator("search_path")
    @classmethod
    def _check_search_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            return None
        if not _SEARCH_PATH_RE.match(trimmed):
            raise ValueError(
                "search_path must be a comma-separated list of plain schema identifiers"
            )
        return trimmed


class BigQuerySettings(_ConnectionSettingsBase):
    """Typed BigQuery execution controls (location, cost guard, dataset scope)."""

    location: str | None = Field(default=None, max_length=40)
    # Cost guard: BigQuery refuses a job whose dry-run estimate exceeds this.
    maximum_bytes_billed: int | None = Field(default=None, ge=1)
    # Datasets the schema browser may enumerate. Empty/unset = the default
    # dataset only (today's behavior).
    dataset_allowlist: list[str] | None = None

    @field_validator("location")
    @classmethod
    def _check_location(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            return None
        if not _BQ_LOCATION_RE.match(trimmed):
            raise ValueError(
                "location must be a BigQuery region or multi-region, e.g. EU, us-east1"
            )
        return trimmed

    @field_validator("dataset_allowlist")
    @classmethod
    def _check_datasets(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        cleaned: list[str] = []
        for raw in value:
            dataset = raw.strip()
            if not dataset:
                continue
            if not _BQ_DATASET_RE.match(dataset):
                raise ValueError(
                    f"dataset_allowlist entry {dataset!r} is not a valid BigQuery dataset id"
                )
            if dataset not in cleaned:
                cleaned.append(dataset)
        if len(cleaned) > _MAX_DATASET_ALLOWLIST:
            raise ValueError(f"dataset_allowlist accepts at most {_MAX_DATASET_ALLOWLIST} datasets")
        return cleaned or None


# The write-side union. Every member forbids extras, so a key that belongs to no
# warehouse at all is rejected by FastAPI before the service is reached; the
# service then checks the parsed settings against the row's db_type (a BigQuery
# key on a PostgreSQL source is a 422, not a silent drop).
ConnectionSettings = ClickHouseSettings | PostgresSettings | BigQuerySettings | SyntheticSettings

CONNECTION_SETTINGS_MODELS: dict[str, type[_ConnectionSettingsBase]] = {
    DBType.clickhouse.value: ClickHouseSettings,
    DBType.postgres.value: PostgresSettings,
    DBType.bigquery.value: BigQuerySettings,
    DBType.synthetic.value: SyntheticSettings,
}

# Every setting name known to *some* warehouse. Used to tell "you sent a setting
# that does not apply to this warehouse" apart from "you sent a typo".
_ALL_SETTING_NAMES: frozenset[str] = frozenset(
    name for model in CONNECTION_SETTINGS_MODELS.values() for name in model.model_fields
)


class ConnectionSettingsError(ValueError):
    """Raised when connection settings are unknown, inapplicable, or malformed."""


def settings_model_for(db_type: str) -> type[_ConnectionSettingsBase]:
    model = CONNECTION_SETTINGS_MODELS.get(str(db_type))
    if model is None:
        raise ConnectionSettingsError(f"Unsupported db_type: {db_type}")
    return model


def parse_connection_settings(
    db_type: str, raw: Mapping[str, object] | None
) -> _ConnectionSettingsBase | None:
    """Validate ``raw`` against the settings model for ``db_type``.

    Raises :class:`ConnectionSettingsError` with an operator-readable message —
    settings that do not apply to this warehouse are rejected, never ignored.
    """
    if raw is None:
        return None
    model = settings_model_for(db_type)
    try:
        return model.model_validate(dict(raw))
    except ValidationError as exc:
        raise ConnectionSettingsError(_explain(db_type, model, exc)) from exc


def _explain(db_type: str, model: type[_ConnectionSettingsBase], exc: ValidationError) -> str:
    """Turn a pydantic ValidationError into one clear sentence for the operator."""
    inapplicable: list[str] = []
    unknown: list[str] = []
    other: list[str] = []
    for error in exc.errors():
        field = ".".join(str(part) for part in error["loc"]) or "connection_settings"
        if error["type"] == "extra_forbidden":
            (inapplicable if field in _ALL_SETTING_NAMES else unknown).append(field)
        else:
            other.append(f"{field}: {error['msg']}")

    parts: list[str] = []
    if inapplicable:
        applicable = ", ".join(model.model_fields) or "none"
        parts.append(
            f"{', '.join(sorted(inapplicable))} "
            f"{'is' if len(inapplicable) == 1 else 'are'} not a connection setting for a "
            f"{db_type} data source (applicable settings: {applicable})"
        )
    if unknown:
        parts.append(f"unknown connection settings: {', '.join(sorted(unknown))}")
    parts.extend(other)
    return "Invalid connection settings — " + "; ".join(parts)


class ConnectionSettingsResponse(BaseModel):
    """Read side of the connection settings: the union, flattened, secrets removed.

    Applicability is enforced on write, so the response can be one flat object;
    only the fields that apply to the source's ``db_type`` are ever populated.
    """

    # BigQuery
    location: str | None = None
    maximum_bytes_billed: int | None = None
    dataset_allowlist: list[str] | None = None
    # PostgreSQL
    sslmode: PostgresSslMode | None = None
    sslrootcert: str | None = None
    sslcert: str | None = None
    search_path: str | None = None
    # The private key itself is never returned — only whether one is stored.
    sslkey_set: bool = False


_RESPONSE_FIELDS = frozenset(ConnectionSettingsResponse.model_fields) - {"sslkey_set"}


def connection_settings_response(stored: Mapping[str, object] | None) -> ConnectionSettingsResponse:
    """Build the public view of a stored settings blob.

    Lenient by design: a GET must never 500 on a legacy or hand-edited row, so
    unrecognized storage keys are dropped here (writes are what validate).
    """
    if not stored:
        return ConnectionSettingsResponse()
    known = {key: value for key, value in stored.items() if key in _RESPONSE_FIELDS}
    return ConnectionSettingsResponse.model_validate(
        {**known, "sslkey_set": bool(stored.get(SSLKEY_STORAGE_KEY))}
    )


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
    connection_settings: ConnectionSettings | None = None

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
    # Replaces the stored settings wholesale (a field left out is cleared), with
    # one exception: an omitted ``sslkey`` keeps the stored key, exactly like an
    # omitted password. Send ``"sslkey": ""`` to clear it.
    connection_settings: ConnectionSettings | None = None

    @field_validator("host")
    @classmethod
    def _check_host(cls, value: str | None) -> str | None:
        return _validate_host_format(value)


class DataSourceResponse(BaseModel):
    id: uuid.UUID
    name: str
    db_type: DBType
    # True when this is a local, in-memory synthetic warehouse (demo data). The
    # UI uses it to badge the source as synthetic rather than a real connection.
    is_synthetic: bool
    host: str
    port: int
    database_name: str
    username: str
    password_set: bool
    timeout_seconds: int | None = None
    json_path_discovery: JsonPathDiscovery | None = None
    connection_settings: ConnectionSettingsResponse
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
