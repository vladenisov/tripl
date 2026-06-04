"""add variable value contexts

Revision ID: e5f6a7b8c9d0
Revises: d4f5e6a7b8c9
Create Date: 2026-06-04 18:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: str | None = "d4f5e6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "variable_values",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("branch_id", sa.Uuid(), nullable=False),
        sa.Column("variable_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("field_definition_id", sa.Uuid(), nullable=False),
        sa.Column("source_column", sa.String(length=255), nullable=False),
        sa.Column("value_kind", sa.String(length=10), nullable=False),
        sa.Column("observed_count", sa.Integer(), nullable=False),
        sa.Column("values", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["branch_id"], ["plan_branches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["field_definition_id"], ["field_definitions.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["variable_id"], ["variables.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "variable_id",
            "event_id",
            "field_definition_id",
            name="uq_variable_value_context",
        ),
    )
    op.create_index("ix_variable_values_branch_id", "variable_values", ["branch_id"])
    op.create_index("ix_variable_values_event", "variable_values", ["event_id"])
    op.create_index(
        "ix_variable_values_project_branch",
        "variable_values",
        ["project_id", "branch_id"],
    )
    op.create_index("ix_variable_values_variable", "variable_values", ["variable_id"])


def downgrade() -> None:
    op.drop_index("ix_variable_values_variable", table_name="variable_values")
    op.drop_index("ix_variable_values_project_branch", table_name="variable_values")
    op.drop_index("ix_variable_values_event", table_name="variable_values")
    op.drop_index("ix_variable_values_branch_id", table_name="variable_values")
    op.drop_table("variable_values")
