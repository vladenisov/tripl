"""add search_document description column

Revision ID: a1c2e3f4b5d6
Revises: e8f9a0b1c2d3
Create Date: 2026-06-03 10:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a1c2e3f4b5d6"
down_revision = "e8f9a0b1c2d3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "search_documents",
        sa.Column("description", sa.Text(), server_default="", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("search_documents", "description")
