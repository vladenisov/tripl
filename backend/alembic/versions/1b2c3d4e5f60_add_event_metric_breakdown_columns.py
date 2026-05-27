"""add event metric breakdown columns

Revision ID: 1b2c3d4e5f60
Revises: 0a1b2c3d4e6f
Create Date: 2026-05-27 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "1b2c3d4e5f60"
down_revision: str | None = "0a1b2c3d4e6f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "events",
        sa.Column(
            "metric_breakdown_columns",
            sa.JSON(),
            server_default="[]",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("events", "metric_breakdown_columns")
