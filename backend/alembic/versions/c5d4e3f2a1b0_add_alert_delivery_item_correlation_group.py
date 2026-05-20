"""add alert_delivery_items.correlation_group_id

Revision ID: c5d4e3f2a1b0
Revises: af42585c6630
Create Date: 2026-05-20 23:50:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5d4e3f2a1b0"
down_revision: str | None = "af42585c6630"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alert_delivery_items",
        sa.Column("correlation_group_id", sa.Uuid(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("alert_delivery_items", "correlation_group_id")
