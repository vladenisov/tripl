"""add event last_seen_at

Revision ID: a1b2c3d4e5f6
Revises: f9a0b1c2d3e4
Create Date: 2026-05-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a1b2c3d4e5f6"
down_revision = "f9a0b1c2d3e4"
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
