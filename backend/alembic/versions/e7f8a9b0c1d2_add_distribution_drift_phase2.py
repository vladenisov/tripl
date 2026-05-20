"""add distribution drift phase 2 config and alert gate

Revision ID: e7f8a9b0c1d2
Revises: d6e5f4a3b2c1
Create Date: 2026-05-20 23:59:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7f8a9b0c1d2"
down_revision: str | None = "d6e5f4a3b2c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scan_configs",
        sa.Column(
            "distribution_drift_fields",
            sa.JSON(),
            server_default="[]",
            nullable=False,
        ),
    )
    op.add_column(
        "alert_rules",
        sa.Column(
            "include_distribution_drifts",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("alert_rules", "include_distribution_drifts")
    op.drop_column("scan_configs", "distribution_drift_fields")
