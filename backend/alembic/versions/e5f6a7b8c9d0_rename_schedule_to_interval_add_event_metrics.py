"""rename schedule to interval and add event_metrics

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-04-07
"""

import sqlalchemy as sa
from alembic import op

revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Rename schedule -> interval in scan_configs
    op.alter_column("scan_configs", "schedule", new_column_name="interval")
    # Shrink to String(10) — all valid values fit
    op.alter_column(
        "scan_configs", "interval",
        existing_type=sa.String(100),
        type_=sa.String(10),
        existing_nullable=True,
    )

    # Create event_metrics table
    op.create_table(
        "event_metrics",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("event_type_id", sa.Uuid(), nullable=True),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("count", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["event_type_id"], ["event_types.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("scan_config_id", "event_id", "bucket", name="uq_event_metric_config_event_bucket"),
        sa.UniqueConstraint("scan_config_id", "event_type_id", "bucket", name="uq_event_metric_config_type_bucket"),
    )
    op.create_index("ix_event_metric_event_bucket", "event_metrics", ["event_id", "bucket"])
    op.create_index("ix_event_metric_type_bucket", "event_metrics", ["event_type_id", "bucket"])


def downgrade() -> None:
    op.drop_index("ix_event_metric_type_bucket", table_name="event_metrics")
    op.drop_index("ix_event_metric_event_bucket", table_name="event_metrics")
    op.drop_table("event_metrics")

    op.alter_column(
        "scan_configs", "interval",
        existing_type=sa.String(10),
        type_=sa.String(100),
        existing_nullable=True,
    )
    op.alter_column("scan_configs", "interval", new_column_name="schedule")
