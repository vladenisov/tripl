"""add distribution_drifts table

Revision ID: d6e5f4a3b2c1
Revises: c5d4e3f2a1b0
Create Date: 2026-05-20 23:55:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "d6e5f4a3b2c1"
down_revision: str | None = "c5d4e3f2a1b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "distribution_drifts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "scan_config_id",
            sa.Uuid(),
            sa.ForeignKey("scan_configs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "event_type_id",
            sa.Uuid(),
            sa.ForeignKey("event_types.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("field_name", sa.String(length=255), nullable=False),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("psi", sa.Float(), nullable=False),
        sa.Column("band", sa.String(length=16), nullable=False),
        sa.Column("baseline_total", sa.Integer(), nullable=False),
        sa.Column("current_total", sa.Integer(), nullable=False),
        sa.Column(
            "top_movers",
            JSONB().with_variant(sa.JSON(), "sqlite"),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_distribution_drift_scan_field_bucket",
        "distribution_drifts",
        ["scan_config_id", "field_name", "bucket"],
    )
    op.create_index(
        "ix_distribution_drift_event_type",
        "distribution_drifts",
        ["event_type_id", "bucket"],
    )


def downgrade() -> None:
    op.drop_index("ix_distribution_drift_event_type", table_name="distribution_drifts")
    op.drop_index("ix_distribution_drift_scan_field_bucket", table_name="distribution_drifts")
    op.drop_table("distribution_drifts")
