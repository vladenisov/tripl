"""add alert_delivery dispatch_attempts

Revision ID: 4f5e6d7c8b9a
Revises: 3f4e5d6c7b8a
Create Date: 2026-06-09 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4f5e6d7c8b9a"
down_revision: str | None = "3f4e5d6c7b8a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alert_deliveries",
        sa.Column(
            "dispatch_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("alert_deliveries", "dispatch_attempts")
