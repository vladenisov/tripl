"""add scan config query limits

Revision ID: 1f2e3d4c5b6a
Revises: f1a2b3c4d5e6
Create Date: 2026-06-04 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "1f2e3d4c5b6a"
down_revision: str | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("scan_configs", sa.Column("scan_row_limit", sa.Integer(), nullable=True))
    op.add_column("scan_configs", sa.Column("metrics_row_limit", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("scan_configs", "metrics_row_limit")
    op.drop_column("scan_configs", "scan_row_limit")
