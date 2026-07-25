"""Raise default anomaly sensitivity: sigma 3.0 -> 4.0, min expected 10 -> 50.

Data-only migration. A row moves to the new defaults only when BOTH knobs
still sit exactly at the old defaults — if a user (or the false-positive
self-tune loop) touched either value, the whole row is considered tuned and
left alone. Applies to both homes of the knobs: project_anomaly_settings
(worker detection) and scan_configs (chart bands + self-tune target).

Revision ID: 9f8e7d6c5b4a
Revises: f1e2d3c4b5a6
Create Date: 2026-07-25
"""

from collections.abc import Sequence

from alembic import op

revision: str = "9f8e7d6c5b4a"
down_revision: str | None = "f1e2d3c4b5a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = ("project_anomaly_settings", "scan_configs")


def upgrade() -> None:
    for table in _TABLES:
        op.execute(
            f"UPDATE {table} SET sigma_threshold = 4.0, min_expected_count = 50 "
            "WHERE sigma_threshold = 3.0 AND min_expected_count = 10"
        )


def downgrade() -> None:
    for table in _TABLES:
        op.execute(
            f"UPDATE {table} SET sigma_threshold = 3.0, min_expected_count = 10 "
            "WHERE sigma_threshold = 4.0 AND min_expected_count = 50"
        )
