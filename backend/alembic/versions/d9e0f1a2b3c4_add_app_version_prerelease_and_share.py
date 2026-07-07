"""add app_version prerelease pattern + active share override to scan_configs

Revision ID: d9e0f1a2b3c4
Revises: d8e9f0a1b2c3
Create Date: 2026-07-07 00:00:00.000000

Two optional per-scan overrides for the version-activation gate:
``app_version_prerelease_pattern`` (a regex; matching version strings are treated
as pre-release/dev builds — excluded from "latest" and from retention priority,
on top of the always-on SemVer pre-release-tag default) and
``app_version_active_share_min`` (overrides the default 0.05 activation
traffic-share floor). Both are nullable — NULL keeps the system defaults — so
existing rows need no backfill.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d9e0f1a2b3c4"
down_revision: str | None = "d8e9f0a1b2c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scan_configs",
        sa.Column("app_version_prerelease_pattern", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "scan_configs",
        sa.Column("app_version_active_share_min", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("scan_configs", "app_version_active_share_min")
    op.drop_column("scan_configs", "app_version_prerelease_pattern")
