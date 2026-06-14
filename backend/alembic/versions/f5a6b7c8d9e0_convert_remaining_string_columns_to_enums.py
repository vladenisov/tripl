"""convert remaining string columns to native enums

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-06-14 13:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f5a6b7c8d9e0"
down_revision: str | None = "e4f5a6b7c8d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ENUMS: dict[str, tuple[str, ...]] = {
    "field_definition_type": ("string", "number", "boolean", "json", "enum", "url"),
    "meta_field_type": ("string", "url", "boolean", "enum", "date"),
    "sensitivity_level": ("none", "pii", "phi", "financial", "secret"),
    "schema_drift_type": (
        "new_field",
        "missing_field",
        "type_changed",
        "enum_violation",
        "required_null_violation",
        "regex_violation",
        "range_violation",
    ),
    "schema_drift_status": ("open", "accepted", "snoozed", "false_positive"),
    "alert_inbox_status": ("open", "acknowledged", "resolved", "muted", "false_positive"),
    "shadow_event_status": ("new", "accepted", "dismissed"),
    "event_photo_kind": ("photo", "figma"),
    "event_photo_storage_backend": ("local", "gcs"),
    "scan_interval": ("15m", "1h", "6h", "1d", "1w"),
    "merge_resolution_choice": ("ours", "theirs"),
    "metric_scope_type": (
        "project_total",
        "event_type",
        "event",
        "schema",
        "distribution",
        "release_regression",
    ),
    "chart_annotation_scope_type": ("project_total", "event_type", "event"),
    "anomaly_direction": ("spike", "drop"),
    "alert_drift_type": (
        "new_field",
        "missing_field",
        "type_changed",
        "enum_violation",
        "required_null_violation",
        "regex_violation",
        "range_violation",
        "distribution_shift",
        "missing",
        "volume_drop",
    ),
    "release_regression_kind": ("missing", "volume_drop"),
    "distribution_drift_band": ("stable", "minor", "significant"),
    "alert_rule_filter_field": ("event_type", "event", "direction"),
    "alert_rule_filter_operator": ("eq", "ne", "in", "not_in"),
    "alert_message_format": (
        "plain",
        "slack_mrkdwn",
        "telegram_html",
        "telegram_markdownv2",
    ),
    "user_role": ("owner", "editor", "viewer"),
    "api_key_scope": ("read", "write"),
}

_COLUMNS: tuple[tuple[str, str, str, int, str | None], ...] = (
    ("field_definitions", "field_type", "field_definition_type", 20, None),
    ("field_definitions", "sensitivity", "sensitivity_level", 20, "none"),
    ("meta_field_definitions", "field_type", "meta_field_type", 20, None),
    ("meta_field_definitions", "sensitivity", "sensitivity_level", 20, "none"),
    ("schema_drifts", "drift_type", "schema_drift_type", 32, None),
    ("schema_drifts", "status", "schema_drift_status", 32, "open"),
    ("alert_correlation_states", "status", "alert_inbox_status", 32, "open"),
    ("shadow_event_candidates", "status", "shadow_event_status", 16, None),
    ("event_photos", "kind", "event_photo_kind", 20, "photo"),
    ("event_photos", "storage_backend", "event_photo_storage_backend", 20, None),
    ("scan_configs", "interval", "scan_interval", 10, None),
    ("scan_configs", "replay_chunk_interval", "scan_interval", 10, None),
    ("plan_branch_merge_resolutions", "choice", "merge_resolution_choice", 20, None),
    ("metric_anomalies", "scope_type", "metric_scope_type", 32, None),
    ("metric_anomalies", "direction", "anomaly_direction", 16, None),
    ("metric_breakdown_anomalies", "scope_type", "metric_scope_type", 32, None),
    ("metric_breakdown_anomalies", "direction", "anomaly_direction", 16, None),
    ("alert_delivery_items", "scope_type", "metric_scope_type", 32, None),
    ("alert_delivery_items", "direction", "anomaly_direction", 16, None),
    ("alert_delivery_items", "drift_type", "alert_drift_type", 32, None),
    ("alert_rule_states", "scope_type", "metric_scope_type", 32, None),
    ("release_regressions", "scope_type", "metric_scope_type", 32, None),
    ("release_regressions", "kind", "release_regression_kind", 16, None),
    ("distribution_drifts", "band", "distribution_drift_band", 16, None),
    ("alert_rule_filters", "field", "alert_rule_filter_field", 32, None),
    ("alert_rule_filters", "operator", "alert_rule_filter_operator", 16, None),
    ("alert_rules", "message_format", "alert_message_format", 64, "plain"),
    ("users", "role", "user_role", 20, "editor"),
    ("api_keys", "scope", "api_key_scope", 20, None),
    ("chart_annotations", "scope_type", "chart_annotation_scope_type", 30, None),
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


def _normalize_legacy_values() -> None:
    op.execute(
        "UPDATE schema_drifts SET drift_type = 'type_changed' WHERE drift_type = 'type_mismatch'"
    )
    op.execute(
        "UPDATE schema_drifts SET drift_type = 'enum_violation' WHERE drift_type = 'new_value'"
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

    _normalize_legacy_values()
    _create_enum_types()
    for table_name, column_name, enum_name, varchar_length, server_default in _COLUMNS:
        _alter_to_enum(table_name, column_name, enum_name, varchar_length, server_default)


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    for table_name, column_name, enum_name, varchar_length, server_default in reversed(_COLUMNS):
        _alter_to_varchar(table_name, column_name, enum_name, varchar_length, server_default)
    _drop_enum_types()
