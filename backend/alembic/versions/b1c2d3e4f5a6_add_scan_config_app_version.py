"""add scan config app version columns

Revision ID: b1c2d3e4f5a6
Revises: e0f1a2b3c4d5
Create Date: 2026-06-14 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: str | None = "e0f1a2b3c4d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scan_configs",
        sa.Column("app_version_column", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "scan_configs",
        sa.Column("app_version_keep_releases", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("scan_configs", "app_version_keep_releases")
    op.drop_column("scan_configs", "app_version_column")
