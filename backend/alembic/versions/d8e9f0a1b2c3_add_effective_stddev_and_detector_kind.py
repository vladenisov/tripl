"""add effective_stddev + detector_kind to anomaly stores

Revision ID: d8e9f0a1b2c3
Revises: c7d8e9f0a1b2
Create Date: 2026-07-07 00:00:00.000000

Anomaly rows now record the floored stddev actually used in the z-score
denominator (``effective_stddev``) and which detector path produced them
(``detector_kind``: "phase" | "rolling" | "trend" | "fractional"). The chart
band is drawn as ``expected ± sigma_threshold * effective_stddev`` so "outside
the band" visually equals "flagged". Both columns are NOT NULL with a
server_default so existing rows backfill cleanly (0.0 / "phase").
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8e9f0a1b2c3"
down_revision: str | None = "c7d8e9f0a1b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES: tuple[str, ...] = ("metric_anomalies", "metric_breakdown_anomalies")


def upgrade() -> None:
    for table in _TABLES:
        op.add_column(
            table,
            sa.Column(
                "effective_stddev",
                sa.Float(),
                server_default="0",
                nullable=False,
            ),
        )
        op.add_column(
            table,
            sa.Column(
                "detector_kind",
                sa.String(length=16),
                server_default="phase",
                nullable=False,
            ),
        )


def downgrade() -> None:
    for table in _TABLES:
        op.drop_column(table, "detector_kind")
        op.drop_column(table, "effective_stddev")
