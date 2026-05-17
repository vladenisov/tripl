"""add plan_revisions

Revision ID: 9e0f1a2b3c4d
Revises: 8d9e0f1a2b3c
Create Date: 2026-05-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "9e0f1a2b3c4d"
down_revision = "8d9e0f1a2b3c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "plan_revisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_plan_revisions_project_created",
        "plan_revisions",
        ["project_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_plan_revisions_project_created", table_name="plan_revisions")
    op.drop_table("plan_revisions")
