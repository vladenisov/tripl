"""add metric_definitions catalog table

Revision ID: d6e7f8a9b0c1
Revises: c4d5e6f7a8b1
Create Date: 2026-06-29 12:00:00.000000

First-class user-defined metrics catalog (epic tripl-dxhp). ``MetricDefinition``
is a GLOBAL, project-scoped entity (no branch_id) defined as one of three kinds
(sql / fact_aggregation / event_composition). Creates four native enum types and
the ``metric_definitions`` table; reuses the existing ``scan_interval`` enum.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d6e7f8a9b0c1"
down_revision: str | None = "c4d5e6f7a8b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW_ENUMS: dict[str, tuple[str, ...]] = {
    "metric_kind": ("sql", "fact_aggregation", "event_composition"),
    "metric_status": ("draft", "active", "archived"),
    "metric_aggregation": ("count", "sum", "avg", "min", "max", "count_distinct"),
    "metric_composition": ("single", "ratio", "per_distinct_user"),
}

# Reused, already-created enum type (do NOT create or drop it here).
_SCAN_INTERVAL = ("15m", "1h", "6h", "1d", "1w")


def _enum(name: str) -> postgresql.ENUM:
    return postgresql.ENUM(*_NEW_ENUMS[name], name=name, create_type=False)


def _scan_interval() -> postgresql.ENUM:
    return postgresql.ENUM(*_SCAN_INTERVAL, name="scan_interval", create_type=False)


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    bind = op.get_bind()
    for name, values in _NEW_ENUMS.items():
        postgresql.ENUM(*values, name=name).create(bind, checkfirst=True)

    op.create_table(
        "metric_definitions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("color", sa.String(length=7), nullable=False),
        sa.Column("order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("unit", sa.String(length=50), nullable=True),
        sa.Column("status", _enum("metric_status"), server_default="draft", nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=True),
        sa.Column("reviewed", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("kind", _enum("metric_kind"), nullable=False),
        sa.Column("aggregation", _enum("metric_aggregation"), nullable=True),
        sa.Column("composition", _enum("metric_composition"), nullable=True),
        sa.Column("config", sa.JSON(), server_default="{}", nullable=False),
        sa.Column("breakdown_columns", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("breakdown_values_limit", sa.Integer(), nullable=True),
        sa.Column("app_version_column", sa.String(length=255), nullable=True),
        sa.Column("platform_column", sa.String(length=255), nullable=True),
        sa.Column("data_source_id", sa.Uuid(), nullable=True),
        sa.Column("interval", _scan_interval(), nullable=True),
        sa.Column("replay_chunk_interval", _scan_interval(), nullable=True),
        sa.Column("numerator_event_id", sa.Uuid(), nullable=True),
        sa.Column("numerator_event_type_id", sa.Uuid(), nullable=True),
        sa.Column("denominator_event_id", sa.Uuid(), nullable=True),
        sa.Column("denominator_event_type_id", sa.Uuid(), nullable=True),
        sa.Column(
            "anomaly_detection_enabled",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column("last_collected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_collection_status", sa.String(length=32), nullable=True),
        sa.Column("last_collection_error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["numerator_event_id"], ["events.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["numerator_event_type_id"], ["event_types.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["denominator_event_id"], ["events.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["denominator_event_type_id"], ["event_types.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "name", name="uq_metric_def_project_name"),
    )
    op.create_index("ix_metric_def_project_order", "metric_definitions", ["project_id", "order"])
    op.create_index("ix_metric_def_project_status", "metric_definitions", ["project_id", "status"])
    op.create_index("ix_metric_definitions_owner_id", "metric_definitions", ["owner_id"])


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    op.drop_index("ix_metric_definitions_owner_id", table_name="metric_definitions")
    op.drop_index("ix_metric_def_project_status", table_name="metric_definitions")
    op.drop_index("ix_metric_def_project_order", table_name="metric_definitions")
    op.drop_table("metric_definitions")

    bind = op.get_bind()
    for name, values in reversed(_NEW_ENUMS.items()):
        postgresql.ENUM(*values, name=name).drop(bind, checkfirst=True)
