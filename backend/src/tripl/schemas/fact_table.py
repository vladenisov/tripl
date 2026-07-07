from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from tripl.core.adapters.measure_validator import (
    validate_identifier,
    validate_select_sql_safety,
    validate_sql_fragment,
)


def _validate_optional_identifier(value: str | None) -> str | None:
    """Run ``validate_identifier`` on a non-None identifier-class field.

    Identifier-class fields flow into warehouse SQL with no bound parameters, so
    the schema boundary is the only gate. ``None`` (the field is absent) is left
    untouched; any provided value must pass the allowlist regex or raise.
    """
    return value if value is None else validate_identifier(value)


def _validate_identifier_list(value: list[str]) -> list[str]:
    """Validate every member of an identifier-column list against the allowlist."""
    return [validate_identifier(item) for item in value]


# ── Nested value objects ─────────────────────────────────────────────────────


class FactTableColumnSchema(BaseModel):
    """A single introspected column descriptor: its name and warehouse type."""

    name: str = Field(min_length=1, max_length=255)
    type: str = Field(min_length=1, max_length=255)


class FactTableRowFilter(BaseModel):
    """A reusable named row filter: a label plus a boolean WHERE fragment.

    The ``sql`` fragment flows into warehouse SQL with no bound parameters, so it
    is validated at this boundary via the shared SQL-fragment validator (rejects
    comment markers, ``;`` separators, and DDL/DML/``UNION`` keywords).
    """

    name: str = Field(min_length=1, max_length=255)
    sql: str = Field(min_length=1)

    @field_validator("sql")
    @classmethod
    def _check_sql(cls, value: str) -> str:
        return validate_sql_fragment(value)


# ── Create ───────────────────────────────────────────────────────────────────


class FactTableCreate(BaseModel):
    """Create a fact table from a full read-only query plus its column metadata.

    ``sql`` must be a single read-only ``SELECT`` or top-level ``WITH ... SELECT``
    (validated via the shared SELECT-safety path that rejects stacked statements,
    comments, DDL/DML and ``UNION``). ``timestamp_column`` and
    ``identifier_columns`` are validated as bare identifiers since they reach
    warehouse SQL unparameterised.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    display_name: str = Field(min_length=1, max_length=255)
    description: str = ""
    color: str = Field(default="#6366f1", pattern=r"^#[0-9a-fA-F]{6}$")
    data_source_id: uuid.UUID | None = None
    sql: str = Field(min_length=1)
    timestamp_column: str = Field(min_length=1, max_length=255)
    columns: list[FactTableColumnSchema] = Field(default_factory=list)
    identifier_columns: list[str] = Field(default_factory=list)
    row_filters: list[FactTableRowFilter] = Field(default_factory=list)

    @field_validator("sql")
    @classmethod
    def _check_sql(cls, value: str) -> str:
        return validate_select_sql_safety(value)

    @field_validator("timestamp_column")
    @classmethod
    def _check_timestamp_column(cls, value: str) -> str:
        return validate_identifier(value)

    @field_validator("identifier_columns")
    @classmethod
    def _check_identifier_columns(cls, value: list[str]) -> list[str]:
        return _validate_identifier_list(value)

    def to_create_values(self) -> dict[str, object]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "description": self.description,
            "color": self.color,
            "data_source_id": self.data_source_id,
            "sql": self.sql,
            "timestamp_column": self.timestamp_column,
            "columns": [column.model_dump() for column in self.columns],
            "identifier_columns": list(self.identifier_columns),
            "row_filters": [row_filter.model_dump() for row_filter in self.row_filters],
        }


# ── Update ───────────────────────────────────────────────────────────────────


class FactTableUpdate(BaseModel):
    """Partial update of a fact table.

    ``name`` is immutable (it is the per-project identity) — recreate the fact
    table to rename it. Every other field is optional; ``exclude_unset`` at the
    service layer keeps only the fields the client actually sent.
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    order: int | None = Field(default=None, ge=0)
    data_source_id: uuid.UUID | None = None
    sql: str | None = Field(default=None, min_length=1)
    timestamp_column: str | None = Field(default=None, min_length=1, max_length=255)
    columns: list[FactTableColumnSchema] | None = None
    identifier_columns: list[str] | None = None
    row_filters: list[FactTableRowFilter] | None = None

    @field_validator("order")
    @classmethod
    def _reject_null_order(cls, value: int | None) -> int:
        # ``order`` maps to a NOT NULL column. ``None`` here only reaches the
        # validator when the client explicitly sends ``"order": null`` (an unset
        # field is excluded by ``exclude_unset`` and never validated), so reject
        # it at the boundary rather than letting it surface as a DB-level 500.
        if value is None:
            msg = "order cannot be null"
            raise ValueError(msg)
        return value

    @field_validator("sql")
    @classmethod
    def _check_sql(cls, value: str | None) -> str | None:
        return value if value is None else validate_select_sql_safety(value)

    @field_validator("timestamp_column")
    @classmethod
    def _check_timestamp_column(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)

    @field_validator("identifier_columns")
    @classmethod
    def _check_identifier_columns(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else _validate_identifier_list(value)


# ── Read models ──────────────────────────────────────────────────────────────


class FactTableResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    display_name: str
    description: str
    color: str
    order: int
    data_source_id: uuid.UUID | None
    sql: str
    timestamp_column: str
    columns: list[FactTableColumnSchema]
    identifier_columns: list[str]
    row_filters: list[FactTableRowFilter]
    created_at: datetime
    updated_at: datetime


class FactTableListItem(BaseModel):
    """Slim catalog row: presentation + source binding, without the heavy SQL."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    display_name: str
    description: str
    color: str
    order: int
    data_source_id: uuid.UUID | None
    timestamp_column: str
    created_at: datetime
    updated_at: datetime


class FactTableListResponse(BaseModel):
    items: list[FactTableListItem]
    total: int


# ── Preview / introspect ─────────────────────────────────────────────────────


class FactTablePreviewRequest(BaseModel):
    """Introspect a candidate read-only SELECT/CTE before saving a fact table."""

    model_config = ConfigDict(extra="forbid")

    data_source_id: uuid.UUID | None = None
    sql: str = Field(min_length=1)
    timestamp_column: str | None = None

    @field_validator("sql")
    @classmethod
    def _check_sql(cls, value: str) -> str:
        return validate_select_sql_safety(value)

    @field_validator("timestamp_column")
    @classmethod
    def _check_timestamp_column(cls, value: str | None) -> str | None:
        return _validate_optional_identifier(value)


class FactTablePreviewResponse(BaseModel):
    columns: list[FactTableColumnSchema]
    identifier_candidates: list[str]
    sample_rows: list[dict[str, object]]
