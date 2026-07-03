"""add project_branch_settings (merge policy)

Revision ID: c5d6e7f8a9b0
Revises: b3c4d5e6f7a8
Create Date: 2026-07-02 12:00:00.000000

Per-project merge policy for plan branches (tripl-s8t0): configurable minimum
number of distinct approvals before merge and an optional guard blocking the
branch author from approving their own branch. Defaults (1 approval, self-
approval allowed) reproduce the pre-policy behavior, so existing projects are
unaffected until they opt in.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5d6e7f8a9b0"
down_revision: str | None = "b3c4d5e6f7a8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_branch_settings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("min_approvals", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "block_self_approval",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
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
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", name="uq_project_branch_settings_project"),
    )


def downgrade() -> None:
    op.drop_table("project_branch_settings")
