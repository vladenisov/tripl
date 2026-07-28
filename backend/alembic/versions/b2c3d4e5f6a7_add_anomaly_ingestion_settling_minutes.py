"""add per-project ingestion-settling allowance for anomaly emission

Additive column on project_anomaly_settings. The server default of 120 minutes
reproduces the previously hard-coded ``ANOMALY_INGESTION_SETTLING`` of 2 hours
in ``worker.tasks.metrics.tasks``, so existing rows read 120 (never NULL) and
detection latency is unchanged until a project opts into a different allowance.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f9
Create Date: 2026-07-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: str | None = "a1b2c3d4e5f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "project_anomaly_settings",
        sa.Column(
            "anomaly_ingestion_settling_minutes",
            sa.Integer(),
            nullable=False,
            server_default="120",
        ),
    )


def downgrade() -> None:
    op.drop_column("project_anomaly_settings", "anomaly_ingestion_settling_minutes")
