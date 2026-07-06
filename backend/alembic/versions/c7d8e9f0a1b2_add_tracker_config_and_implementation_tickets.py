"""add project_tracker_configs and implementation_tickets

Revision ID: c7d8e9f0a1b2
Revises: b4c5d6e7f8a9
Create Date: 2026-07-05 10:00:00.000000

Branch → implementation ticket automation (tripl-hgez). ``project_tracker_configs``
holds the per-project Jira integration (owner-gated, one row per project, token
stored encrypted). ``implementation_tickets`` records one tracker ticket per
merged branch, covering the branch's added/changed events by their main-branch
event ids; polling sync flips it closed and marks those events implemented once
the ticket's tracker status category is ``done``.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7d8e9f0a1b2"
down_revision: str | None = "b4c5d6e7f8a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_tracker_configs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("tracker_type", sa.String(), server_default="jira", nullable=False),
        sa.Column("base_url", sa.String(), server_default="", nullable=False),
        sa.Column("project_key", sa.String(), server_default="", nullable=False),
        sa.Column("auth_email", sa.String(), server_default="", nullable=False),
        sa.Column("api_token_encrypted", sa.String(), server_default="", nullable=False),
        sa.Column("issue_type", sa.String(), server_default="Task", nullable=False),
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
        sa.UniqueConstraint("project_id", name="uq_project_tracker_config_project"),
    )
    op.create_table(
        "implementation_tickets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("branch_id", sa.Uuid(), nullable=False),
        sa.Column("tracker_type", sa.String(), server_default="jira", nullable=False),
        sa.Column("external_id", sa.String(), nullable=True),
        sa.Column("external_key", sa.String(), nullable=True),
        sa.Column("external_url", sa.String(), server_default="", nullable=False),
        sa.Column("status", sa.String(), server_default="open", nullable=False),
        sa.Column("summary", sa.String(), server_default="", nullable=False),
        sa.Column("event_ids", sa.JSON(), server_default="[]", nullable=False),
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
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["branch_id"], ["plan_branches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("implementation_tickets")
    op.drop_table("project_tracker_configs")
