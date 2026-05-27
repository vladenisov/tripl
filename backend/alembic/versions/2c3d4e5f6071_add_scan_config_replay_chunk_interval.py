"""add scan_config replay_chunk_interval

Revision ID: 2c3d4e5f6071
Revises: 1b2c3d4e5f60
Create Date: 2026-05-27 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "2c3d4e5f6071"
down_revision: str | None = "1b2c3d4e5f60"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scan_configs",
        sa.Column("replay_chunk_interval", sa.String(length=10), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("scan_configs", "replay_chunk_interval")
