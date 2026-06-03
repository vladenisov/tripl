"""add scan event group rules

Revision ID: b2c3d4e5f6a8
Revises: a1c2e3f4b5d6
Create Date: 2026-06-03 16:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a8"
down_revision: str | None = "a1c2e3f4b5d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scan_configs",
        sa.Column("event_group_rules", sa.JSON(), server_default="[]", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("scan_configs", "event_group_rules")
