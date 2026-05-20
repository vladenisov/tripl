"""add role column to users

Revision ID: c1d2e3f4a5b6
Revises: b0c1d2e3f4a5
Create Date: 2026-05-17 17:30:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "c1d2e3f4a5b6"
down_revision = "b0c1d2e3f4a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "role",
            sa.String(length=20),
            nullable=False,
            server_default="editor",
        ),
    )
    # Promote the oldest existing user to owner so an existing install retains
    # a manageable instance after the migration.
    op.execute(
        "UPDATE users SET role = 'owner' "
        "WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)"
    )


def downgrade() -> None:
    op.drop_column("users", "role")
