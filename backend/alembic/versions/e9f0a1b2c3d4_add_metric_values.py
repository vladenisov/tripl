"""add metric_values storage tables

Revision ID: e9f0a1b2c3d4
Revises: d6e7f8a9b0c1
Create Date: 2026-06-29 13:00:00.000000

Value-storage layer for collected catalog metric series (epic tripl-dxhp).
Mirrors ``event_metrics`` / ``event_metric_breakdowns`` but is keyed by
``MetricDefinition`` and stores a Float ``value`` instead of a count. The
optional ``scan_config_id`` FK aligns ``event_composition`` metrics onto a
source scan grid. No new enum types are needed.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e9f0a1b2c3d4"
down_revision: str | None = "d6e7f8a9b0c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    op.create_table(
        "metric_values",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("metric_definition_id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=True),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["metric_definition_id"], ["metric_definitions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "metric_definition_id",
            "scan_config_id",
            "bucket",
            name="uq_metric_value_def_config_bucket",
        ),
    )
    op.create_index(
        "ix_metric_value_def_bucket",
        "metric_values",
        ["metric_definition_id", "bucket"],
    )

    op.create_table(
        "metric_value_breakdowns",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("metric_definition_id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=True),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("breakdown_column", sa.String(length=255), nullable=False),
        sa.Column("breakdown_value", sa.String(length=500), nullable=False),
        sa.Column("is_other", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["metric_definition_id"], ["metric_definitions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "metric_definition_id",
            "scan_config_id",
            "bucket",
            "breakdown_column",
            "breakdown_value",
            "is_other",
            name="uq_metric_value_breakdown_def_config_bucket_value",
        ),
    )
    op.create_index(
        "ix_metric_value_breakdown_def_bucket",
        "metric_value_breakdowns",
        ["metric_definition_id", "bucket"],
    )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    op.drop_index("ix_metric_value_breakdown_def_bucket", table_name="metric_value_breakdowns")
    op.drop_table("metric_value_breakdowns")
    op.drop_index("ix_metric_value_def_bucket", table_name="metric_values")
    op.drop_table("metric_values")
