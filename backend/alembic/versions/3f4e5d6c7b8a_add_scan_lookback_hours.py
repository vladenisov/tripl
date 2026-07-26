"""add scan lookback hours

Revision ID: 3f4e5d6c7b8a
Revises: 2f3e4d5c6b7a
Create Date: 2026-06-05 13:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3f4e5d6c7b8a"
down_revision: str | None = "2f3e4d5c6b7a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("scan_configs", sa.Column("scan_lookback_hours", sa.Integer(), nullable=True))
    op.add_column(
        "scan_preview_jobs", sa.Column("time_column", sa.String(length=255), nullable=True)
    )
    op.add_column(
        "scan_preview_jobs", sa.Column("scan_lookback_hours", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("scan_preview_jobs", "scan_lookback_hours")
    op.drop_column("scan_preview_jobs", "time_column")
    op.drop_column("scan_configs", "scan_lookback_hours")
