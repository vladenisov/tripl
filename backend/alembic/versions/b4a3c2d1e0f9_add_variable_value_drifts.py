"""add variable value drifts

Revision ID: b4a3c2d1e0f9
Revises: e9d8c7b6a5f4
Create Date: 2026-07-09 18:00:00.000000

Reuses the existing ``schema_drift_status`` PostgreSQL enum type
(create_type=False) — value-drift rows share the open/accepted/snoozed/
false_positive workflow with schema drift.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b4a3c2d1e0f9"
down_revision: str | None = "e9d8c7b6a5f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    status_enum = postgresql.ENUM(name="schema_drift_status", create_type=False)
    op.create_table(
        "variable_value_drifts",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("variable_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=True),
        sa.Column("observed_values", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("status", status_enum, server_default="open", nullable=False),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("snoozed_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.Uuid(), nullable=True),
        sa.Column(
            "detected_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["variable_id"], ["variables.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("variable_id", "event_id", name="uq_variable_value_drift_context"),
    )
    op.create_index(
        "ix_variable_value_drifts_variable_id", "variable_value_drifts", ["variable_id"]
    )
    op.create_index("ix_variable_value_drifts_event_id", "variable_value_drifts", ["event_id"])
    op.create_index(
        "ix_variable_value_drifts_project_detected",
        "variable_value_drifts",
        ["project_id", "detected_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_variable_value_drifts_project_detected", table_name="variable_value_drifts")
    op.drop_index("ix_variable_value_drifts_event_id", table_name="variable_value_drifts")
    op.drop_index("ix_variable_value_drifts_variable_id", table_name="variable_value_drifts")
    op.drop_table("variable_value_drifts")
