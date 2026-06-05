"""add data source timeout seconds

Revision ID: 2f3e4d5c6b7a
Revises: 1f2e3d4c5b6a
Create Date: 2026-06-05 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "2f3e4d5c6b7a"
down_revision: str | None = "1f2e3d4c5b6a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("data_sources", sa.Column("timeout_seconds", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("data_sources", "timeout_seconds")
