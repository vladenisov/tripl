"""add per-project recent signal window (open-signal freshness) setting

Additive column on project_anomaly_settings. The server default of 24 reproduces
the previously hard-coded ``RECENT_SIGNAL_WINDOW`` of 24 hours, so existing rows
read 24 (never NULL) and signal classification is unchanged until a project opts
into a different window.

Revision ID: a1b2c3d4e5f9
Revises: 9f8e7d6c5b4a
Create Date: 2026-07-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f9"
down_revision: str | None = "9f8e7d6c5b4a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "project_anomaly_settings",
        sa.Column(
            "recent_signal_window_hours",
            sa.Integer(),
            nullable=False,
            server_default="24",
        ),
    )


def downgrade() -> None:
    op.drop_column("project_anomaly_settings", "recent_signal_window_hours")
