"""add event owner_id and reviewed

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-06-18 00:00:00.000000

Per-event ownership (nullable FK to users, SET NULL when the user is deleted)
and a ``reviewed`` flag. Backs the data-first redesign's events-table Owner and
Reviewed columns and the bulk assign-owner / mark-reviewed actions. Ownership
is resolved to a user by the frontend from its own users list, so only the id
is stored here.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "d5e6f7a8b9c0"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("events", sa.Column("owner_id", sa.Uuid(), nullable=True))
    op.add_column(
        "events",
        sa.Column("reviewed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_index("ix_events_owner_id", "events", ["owner_id"])
    op.create_foreign_key(
        "fk_events_owner_id_users",
        "events",
        "users",
        ["owner_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_events_owner_id_users", "events", type_="foreignkey")
    op.drop_index("ix_events_owner_id", table_name="events")
    op.drop_column("events", "reviewed")
    op.drop_column("events", "owner_id")
