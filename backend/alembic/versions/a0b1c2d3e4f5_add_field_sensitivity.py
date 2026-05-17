"""add sensitivity classification to field_definitions and meta_field_definitions

Revision ID: a0b1c2d3e4f5
Revises: 9e0f1a2b3c4d
Create Date: 2026-05-17 11:30:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a0b1c2d3e4f5"
down_revision = "9e0f1a2b3c4d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "field_definitions",
        sa.Column(
            "sensitivity",
            sa.String(length=20),
            nullable=False,
            server_default="none",
        ),
    )
    op.add_column(
        "meta_field_definitions",
        sa.Column(
            "sensitivity",
            sa.String(length=20),
            nullable=False,
            server_default="none",
        ),
    )


def downgrade() -> None:
    op.drop_column("meta_field_definitions", "sensitivity")
    op.drop_column("field_definitions", "sensitivity")
