"""add event last_seen_at

Revision ID: 6b7c8d9e0f1a
Revises: 5a6b7c8d9e0f
Create Date: 2026-05-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "6b7c8d9e0f1a"
down_revision = "5a6b7c8d9e0f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "events",
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_events_last_seen_at", "events", ["last_seen_at"])


def downgrade() -> None:
    op.drop_index("ix_events_last_seen_at", table_name="events")
    op.drop_column("events", "last_seen_at")
