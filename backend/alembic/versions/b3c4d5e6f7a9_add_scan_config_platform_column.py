"""add scan config platform column

Revision ID: b3c4d5e6f7a9
Revises: f1a2b3c4d5e7
Create Date: 2026-06-28 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3c4d5e6f7a9"
down_revision: str | None = "f1a2b3c4d5e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scan_configs",
        sa.Column("platform_column", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("scan_configs", "platform_column")
