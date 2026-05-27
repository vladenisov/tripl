"""add webhook alert destination fields

Revision ID: 3d4e5f607182
Revises: 2c3d4e5f6071
Create Date: 2026-05-27 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3d4e5f607182"
down_revision: str | None = "2c3d4e5f6071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alert_destinations",
        sa.Column("target_url_encrypted", sa.Text(), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("webhook_header_name", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("webhook_header_value_encrypted", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("alert_destinations", "webhook_header_value_encrypted")
    op.drop_column("alert_destinations", "webhook_header_name")
    op.drop_column("alert_destinations", "target_url_encrypted")
