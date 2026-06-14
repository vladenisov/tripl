"""convert string columns to native enums

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-06-14 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e4f5a6b7c8d9"
down_revision: str | None = "d3e4f5a6b7c8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ENUMS: dict[str, tuple[str, ...]] = {
    "alert_delivery_status": ("pending", "sent", "failed"),
    "alert_destination_type": ("slack", "telegram", "webhook", "email", "jira", "linear"),
    "data_source_db_type": ("clickhouse", "postgres", "bigquery"),
    "data_source_test_status": ("success", "failed"),
    "event_status": (
        "draft",
        "in_review",
        "ready_for_dev",
        "implemented",
        "live",
        "deprecated",
        "archived",
    ),
    "plan_branch_kind": ("main", "working"),
    "plan_branch_status": (
        "draft",
        "ready_for_review",
        "changes_requested",
        "approved",
        "merged",
        "closed",
    ),
    "scan_job_status": ("pending", "running", "completed", "failed"),
    "variable_type": (
        "string",
        "number",
        "boolean",
        "date",
        "datetime",
        "json",
        "string_array",
        "number_array",
    ),
    "variable_value_kind": ("low", "high"),
}

_COLUMNS: tuple[tuple[str, str, str, int, str | None], ...] = (
    ("alert_deliveries", "status", "alert_delivery_status", 20, "pending"),
    ("alert_deliveries", "channel", "alert_destination_type", 32, None),
    ("alert_destinations", "type", "alert_destination_type", 32, None),
    ("data_sources", "db_type", "data_source_db_type", 20, None),
    ("data_sources", "last_test_status", "data_source_test_status", 16, None),
    ("events", "status", "event_status", 20, "draft"),
    ("plan_branches", "kind", "plan_branch_kind", 20, "working"),
    ("plan_branches", "status", "plan_branch_status", 30, "draft"),
    ("scan_jobs", "status", "scan_job_status", 20, None),
    ("scan_preview_jobs", "status", "scan_job_status", 20, None),
    ("variables", "variable_type", "variable_type", 20, None),
    ("variable_values", "value_kind", "variable_value_kind", 10, None),
)


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _enum_type(name: str) -> postgresql.ENUM:
    return postgresql.ENUM(*_ENUMS[name], name=name, create_type=False)


def _create_enum_types() -> None:
    bind = op.get_bind()
    for name, values in _ENUMS.items():
        postgresql.ENUM(*values, name=name).create(bind, checkfirst=True)


def _drop_enum_types() -> None:
    bind = op.get_bind()
    for name, values in reversed(_ENUMS.items()):
        postgresql.ENUM(*values, name=name).drop(bind, checkfirst=True)


def _alter_to_enum(
    table_name: str,
    column_name: str,
    enum_name: str,
    varchar_length: int,
    server_default: str | None,
) -> None:
    op.alter_column(
        table_name,
        column_name,
        existing_type=sa.String(length=varchar_length),
        server_default=None,
    )
    enum_type = _enum_type(enum_name)
    op.alter_column(
        table_name,
        column_name,
        existing_type=sa.String(length=varchar_length),
        type_=enum_type,
        postgresql_using=f"{_quote_identifier(column_name)}::{_quote_identifier(enum_name)}",
    )
    if server_default is not None:
        op.alter_column(
            table_name,
            column_name,
            existing_type=enum_type,
            server_default=sa.text(f"'{server_default}'::{_quote_identifier(enum_name)}"),
        )


def _alter_to_varchar(
    table_name: str,
    column_name: str,
    enum_name: str,
    varchar_length: int,
    server_default: str | None,
) -> None:
    enum_type = _enum_type(enum_name)
    op.alter_column(
        table_name,
        column_name,
        existing_type=enum_type,
        server_default=None,
    )
    op.alter_column(
        table_name,
        column_name,
        existing_type=enum_type,
        type_=sa.String(length=varchar_length),
        postgresql_using=f"{_quote_identifier(column_name)}::text",
    )
    if server_default is not None:
        op.alter_column(
            table_name,
            column_name,
            existing_type=sa.String(length=varchar_length),
            server_default=server_default,
        )


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    _create_enum_types()
    for table_name, column_name, enum_name, varchar_length, server_default in _COLUMNS:
        _alter_to_enum(table_name, column_name, enum_name, varchar_length, server_default)


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    for table_name, column_name, enum_name, varchar_length, server_default in reversed(_COLUMNS):
        _alter_to_varchar(table_name, column_name, enum_name, varchar_length, server_default)
    _drop_enum_types()
