"""add release comparabilities

Gives the release-regression pass somewhere to record WHY it concluded what it
concluded. Until now zero ``release_regressions`` rows meant both "this release
is fine" and "this release cannot be judged yet": the comparability verdict was
computed, logged at INFO, and dropped, so the two API payloads were identical
and the UI printed the affirmative for both.

One row per (scan_config, scope_type), rewritten by every recalculation
alongside the regression rows. ``version``/``previous_version`` are nullable
because ``reason = 'no_baseline'`` means no release pair was ever chosen.

Reuses the existing ``metric_scope_type`` PostgreSQL enum (create_type=False,
created by f5a6b7c8d9e0) and creates ``release_comparability_reason``.

Revision ID: d2c3b4a5f6e7
Revises: a4b5c6d7e8fa
Create Date: 2026-08-04 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d2c3b4a5f6e7"
down_revision: str | None = "a4b5c6d7e8fa"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_REASONS = ("comparable", "no_baseline", "baseline_no_volume", "population_mismatch")


def upgrade() -> None:
    postgresql.ENUM(*_REASONS, name="release_comparability_reason").create(
        op.get_bind(), checkfirst=True
    )
    op.create_table(
        "release_comparabilities",
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column(
            "scope_type",
            postgresql.ENUM(name="metric_scope_type", create_type=False),
            nullable=False,
        ),
        sa.Column("app_version_column", sa.String(length=255), nullable=False),
        sa.Column("version", sa.String(length=500), nullable=True),
        sa.Column("previous_version", sa.String(length=500), nullable=True),
        sa.Column("comparable", sa.Boolean(), nullable=False),
        sa.Column(
            "reason",
            postgresql.ENUM(*_REASONS, name="release_comparability_reason", create_type=False),
            nullable=False,
        ),
        sa.Column("emerging_share", sa.Float(), nullable=False),
        sa.Column("max_emerging_share", sa.Float(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scan_config_id",
            "scope_type",
            name="uq_release_comparability_scan_scope",
        ),
    )


def downgrade() -> None:
    op.drop_table("release_comparabilities")
    postgresql.ENUM(*_REASONS, name="release_comparability_reason").drop(
        op.get_bind(), checkfirst=True
    )
