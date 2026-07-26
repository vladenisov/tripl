"""add plan_branch_merge_resolutions table

Revision ID: 93050ed42d05
Revises: 8293050ed42d
Create Date: 2026-05-30 15:00:00.000000

Backs the inline 3-way field-level conflict resolutions captured during
plan-branch review. One row per (branch, entity_type, entity_name, field_name).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "93050ed42d05"
down_revision = "8293050ed42d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plan_branch_merge_resolutions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("branch_id", sa.Uuid(), nullable=False),
        sa.Column("entity_type", sa.String(length=40), nullable=False),
        sa.Column("entity_name", sa.String(length=255), nullable=False),
        sa.Column("field_name", sa.String(length=80), nullable=False),
        sa.Column("choice", sa.String(length=20), nullable=False),
        sa.Column("custom_value", sa.Text(), nullable=True),
        sa.Column("resolved_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["branch_id"], ["plan_branches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "branch_id",
            "entity_type",
            "entity_name",
            "field_name",
            name="uq_plan_branch_merge_resolution",
        ),
    )
    op.create_index(
        "ix_plan_branch_merge_resolutions_branch_id",
        "plan_branch_merge_resolutions",
        ["branch_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_plan_branch_merge_resolutions_branch_id",
        table_name="plan_branch_merge_resolutions",
    )
    op.drop_table("plan_branch_merge_resolutions")
