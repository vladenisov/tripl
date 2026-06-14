"""add release regressions

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-06-14 01:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c2d3e4f5a6b7"
down_revision: str | None = "b1c2d3e4f5a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "release_regressions",
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("scope_ref", sa.String(length=64), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("event_type_id", sa.Uuid(), nullable=True),
        sa.Column("app_version_column", sa.String(length=255), nullable=False),
        sa.Column("version", sa.String(length=500), nullable=False),
        sa.Column("previous_version", sa.String(length=500), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("observed_count", sa.BigInteger(), nullable=False),
        sa.Column("expected_count", sa.Float(), nullable=False),
        sa.Column("ratio", sa.Float(), nullable=False),
        sa.Column("share_prev", sa.Float(), nullable=False),
        sa.Column("share_new", sa.Float(), nullable=False),
        sa.Column("release_share", sa.Float(), nullable=False),
        sa.Column("window_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_to", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["event_type_id"], ["event_types.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "version",
            name="uq_release_regression_scope_version",
        ),
    )
    op.create_index(
        "ix_release_regression_scan_scope",
        "release_regressions",
        ["scan_config_id", "scope_type", "scope_ref"],
        unique=False,
    )
    op.create_index(
        "ix_release_regression_event",
        "release_regressions",
        ["event_id"],
        unique=False,
    )
    op.create_index(
        "ix_release_regression_event_type",
        "release_regressions",
        ["event_type_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_release_regression_event_type", table_name="release_regressions")
    op.drop_index("ix_release_regression_event", table_name="release_regressions")
    op.drop_index("ix_release_regression_scan_scope", table_name="release_regressions")
    op.drop_table("release_regressions")
