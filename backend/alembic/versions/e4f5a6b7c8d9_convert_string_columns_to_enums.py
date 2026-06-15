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


def _deduplicate_variables() -> None:
    """Merge historical duplicate variables before PostgreSQL rebuilds unique indexes.

    Some older production data can contain duplicate rows for
    (project_id, branch_id, name). ALTER COLUMN TYPE rewrites the table and
    rebuilds its unique indexes, so those duplicates must be resolved before
    variables.variable_type is converted to an enum.
    """
    op.execute(
        """
        WITH variable_groups AS (
            SELECT
                project_id,
                branch_id,
                name,
                MIN(id::text)::uuid AS canonical_id
            FROM variables
            GROUP BY project_id, branch_id, name
            HAVING COUNT(*) > 1
        ),
        mapped_variables AS (
            SELECT v.id AS variable_id, vg.canonical_id
            FROM variables AS v
            JOIN variable_groups AS vg
              ON vg.project_id = v.project_id
             AND vg.branch_id = v.branch_id
             AND vg.name = v.name
        ),
        value_groups AS (
            SELECT
                mv.canonical_id,
                vv.event_id,
                vv.field_definition_id,
                MIN(vv.id::text)::uuid AS keep_value_id,
                MAX(vv.observed_count) AS observed_count,
                CASE
                    WHEN BOOL_OR(vv.value_kind = 'high') THEN 'high'
                    ELSE 'low'
                END AS value_kind
            FROM variable_values AS vv
            JOIN mapped_variables AS mv ON mv.variable_id = vv.variable_id
            GROUP BY mv.canonical_id, vv.event_id, vv.field_definition_id
            HAVING COUNT(*) > 1
        ),
        merged_values AS (
            SELECT
                vg.keep_value_id,
                COALESCE(
                    (
                        SELECT jsonb_agg(DISTINCT item.value ORDER BY item.value)
                        FROM mapped_variables AS mv
                        JOIN variable_values AS vv
                          ON vv.variable_id = mv.variable_id
                        CROSS JOIN LATERAL jsonb_array_elements_text(
                            COALESCE(vv."values"::jsonb, '[]'::jsonb)
                        ) AS item(value)
                        WHERE mv.canonical_id = vg.canonical_id
                          AND vv.event_id = vg.event_id
                          AND vv.field_definition_id = vg.field_definition_id
                    ),
                    '[]'::jsonb
                ) AS merged_json
            FROM value_groups AS vg
        )
        UPDATE variable_values AS vv
        SET
            observed_count = vg.observed_count,
            value_kind = vg.value_kind,
            "values" = mv.merged_json::json
        FROM value_groups AS vg
        JOIN merged_values AS mv ON mv.keep_value_id = vg.keep_value_id
        WHERE vv.id = vg.keep_value_id
        """
    )
    op.execute(
        """
        WITH variable_groups AS (
            SELECT
                project_id,
                branch_id,
                name,
                MIN(id::text)::uuid AS canonical_id
            FROM variables
            GROUP BY project_id, branch_id, name
            HAVING COUNT(*) > 1
        ),
        mapped_variables AS (
            SELECT v.id AS variable_id, vg.canonical_id
            FROM variables AS v
            JOIN variable_groups AS vg
              ON vg.project_id = v.project_id
             AND vg.branch_id = v.branch_id
             AND vg.name = v.name
        ),
        value_groups AS (
            SELECT
                mv.canonical_id,
                vv.event_id,
                vv.field_definition_id,
                MIN(vv.id::text)::uuid AS keep_value_id
            FROM variable_values AS vv
            JOIN mapped_variables AS mv ON mv.variable_id = vv.variable_id
            GROUP BY mv.canonical_id, vv.event_id, vv.field_definition_id
            HAVING COUNT(*) > 1
        )
        DELETE FROM variable_values AS vv
        USING mapped_variables AS mv, value_groups AS vg
        WHERE vv.variable_id = mv.variable_id
          AND mv.canonical_id = vg.canonical_id
          AND vv.event_id = vg.event_id
          AND vv.field_definition_id = vg.field_definition_id
          AND vv.id <> vg.keep_value_id
        """
    )
    op.execute(
        """
        WITH variable_groups AS (
            SELECT
                project_id,
                branch_id,
                name,
                MIN(id::text)::uuid AS canonical_id
            FROM variables
            GROUP BY project_id, branch_id, name
            HAVING COUNT(*) > 1
        ),
        mapped_variables AS (
            SELECT v.id AS variable_id, vg.canonical_id
            FROM variables AS v
            JOIN variable_groups AS vg
              ON vg.project_id = v.project_id
             AND vg.branch_id = v.branch_id
             AND vg.name = v.name
        )
        UPDATE variable_values AS vv
        SET variable_id = mv.canonical_id
        FROM mapped_variables AS mv
        WHERE vv.variable_id = mv.variable_id
          AND vv.variable_id <> mv.canonical_id
        """
    )
    op.execute(
        """
        WITH variable_groups AS (
            SELECT
                project_id,
                branch_id,
                name,
                MIN(id::text)::uuid AS canonical_id
            FROM variables
            GROUP BY project_id, branch_id, name
            HAVING COUNT(*) > 1
        ),
        mapped_variables AS (
            SELECT v.id AS variable_id, vg.canonical_id
            FROM variables AS v
            JOIN variable_groups AS vg
              ON vg.project_id = v.project_id
             AND vg.branch_id = v.branch_id
             AND vg.name = v.name
        )
        DELETE FROM variables AS v
        USING mapped_variables AS mv
        WHERE v.id = mv.variable_id
          AND mv.variable_id <> mv.canonical_id
        """
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY project_id, branch_id, source_name
                    ORDER BY id::text
                ) AS row_number
            FROM variables
            WHERE source_name IS NOT NULL
        )
        UPDATE variables AS v
        SET source_name = NULL
        FROM ranked AS r
        WHERE v.id = r.id
          AND r.row_number > 1
        """
    )


def _deduplicate_variable_values() -> None:
    op.execute(
        """
        WITH value_groups AS (
            SELECT
                variable_id,
                event_id,
                field_definition_id,
                MIN(id::text)::uuid AS keep_value_id,
                MAX(observed_count) AS observed_count,
                CASE
                    WHEN BOOL_OR(value_kind = 'high') THEN 'high'
                    ELSE 'low'
                END AS value_kind
            FROM variable_values
            GROUP BY variable_id, event_id, field_definition_id
            HAVING COUNT(*) > 1
        ),
        merged_values AS (
            SELECT
                vg.keep_value_id,
                COALESCE(
                    (
                        SELECT jsonb_agg(DISTINCT item.value ORDER BY item.value)
                        FROM variable_values AS vv
                        CROSS JOIN LATERAL jsonb_array_elements_text(
                            COALESCE(vv."values"::jsonb, '[]'::jsonb)
                        ) AS item(value)
                        WHERE vv.variable_id = vg.variable_id
                          AND vv.event_id = vg.event_id
                          AND vv.field_definition_id = vg.field_definition_id
                    ),
                    '[]'::jsonb
                ) AS merged_json
            FROM value_groups AS vg
        )
        UPDATE variable_values AS vv
        SET
            observed_count = vg.observed_count,
            value_kind = vg.value_kind,
            "values" = mv.merged_json::json
        FROM value_groups AS vg
        JOIN merged_values AS mv ON mv.keep_value_id = vg.keep_value_id
        WHERE vv.id = vg.keep_value_id
        """
    )
    op.execute(
        """
        WITH value_groups AS (
            SELECT
                variable_id,
                event_id,
                field_definition_id,
                MIN(id::text)::uuid AS keep_value_id
            FROM variable_values
            GROUP BY variable_id, event_id, field_definition_id
            HAVING COUNT(*) > 1
        )
        DELETE FROM variable_values AS vv
        USING value_groups AS vg
        WHERE vv.variable_id = vg.variable_id
          AND vv.event_id = vg.event_id
          AND vv.field_definition_id = vg.field_definition_id
          AND vv.id <> vg.keep_value_id
        """
    )


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

    _deduplicate_variables()
    _deduplicate_variable_values()
    _create_enum_types()
    for table_name, column_name, enum_name, varchar_length, server_default in _COLUMNS:
        _alter_to_enum(table_name, column_name, enum_name, varchar_length, server_default)


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    for table_name, column_name, enum_name, varchar_length, server_default in reversed(_COLUMNS):
        _alter_to_varchar(table_name, column_name, enum_name, varchar_length, server_default)
    _drop_enum_types()
