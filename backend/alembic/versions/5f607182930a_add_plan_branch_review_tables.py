"""add plan branch review tables (reviewers, approvals, comments)

Revision ID: 5f607182930a
Revises: 4e5f60718293
Create Date: 2026-05-27 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5f607182930a"
down_revision: str | None = "4e5f60718293"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "plan_branch_reviewers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "branch_id",
            sa.Uuid(),
            sa.ForeignKey("plan_branches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("branch_id", "user_id", name="uq_plan_branch_reviewer"),
    )
    op.create_index("ix_plan_branch_reviewer_branch", "plan_branch_reviewers", ["branch_id"])

    op.create_table(
        "plan_branch_approvals",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "branch_id",
            sa.Uuid(),
            sa.ForeignKey("plan_branches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "approved_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("branch_id", "user_id", name="uq_plan_branch_approval"),
    )
    op.create_index("ix_plan_branch_approval_branch", "plan_branch_approvals", ["branch_id"])

    op.create_table(
        "plan_branch_comments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "branch_id",
            sa.Uuid(),
            sa.ForeignKey("plan_branches.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_id",
            sa.Uuid(),
            sa.ForeignKey("plan_branch_comments.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_plan_branch_comment_branch", "plan_branch_comments", ["branch_id"])


def downgrade() -> None:
    op.drop_index("ix_plan_branch_comment_branch", table_name="plan_branch_comments")
    op.drop_table("plan_branch_comments")
    op.drop_index("ix_plan_branch_approval_branch", table_name="plan_branch_approvals")
    op.drop_table("plan_branch_approvals")
    op.drop_index("ix_plan_branch_reviewer_branch", table_name="plan_branch_reviewers")
    op.drop_table("plan_branch_reviewers")
