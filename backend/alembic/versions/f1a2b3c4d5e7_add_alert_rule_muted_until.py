"""add alert rule muted_until

Revision ID: f1a2b3c4d5e7
Revises: d5e6f7a8b9c0
Create Date: 2026-06-27 00:00:00.000000

Manual snooze for a monitor (alert rule). While ``muted_until`` is in the
future the monitor is treated as muted; NULL means not muted. Additive,
nullable column — safe to apply online with no backfill.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e7"
down_revision: str | None = "d5e6f7a8b9c0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alert_rules",
        sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("alert_rules", "muted_until")
