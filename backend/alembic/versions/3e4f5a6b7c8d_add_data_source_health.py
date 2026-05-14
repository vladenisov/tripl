"""add data source health columns

Revision ID: 3e4f5a6b7c8d
Revises: 2d3e4f5a6b7c
Create Date: 2026-04-25

Adds persistent connection-health fields on ``data_sources`` so the UI
can show whether a connection is healthy across reloads, instead of only
keeping the last in-tab "Test" result.

- ``last_test_at`` — UTC timestamp of the most recent test attempt.
- ``last_test_status`` — ``success`` / ``failed`` / NULL when never tested.
- ``last_test_message`` — error message on failure, success message on
  success. Free-form text so we can refine it without further migrations.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "3e4f5a6b7c8d"
down_revision = "2d3e4f5a6b7c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "data_sources",
        sa.Column("last_test_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "data_sources",
        sa.Column("last_test_status", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "data_sources",
        sa.Column("last_test_message", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("data_sources", "last_test_message")
    op.drop_column("data_sources", "last_test_status")
    op.drop_column("data_sources", "last_test_at")
