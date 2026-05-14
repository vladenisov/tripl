"""add metric anomalies and scan detection settings

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-04-10
"""

import sqlalchemy as sa
from alembic import op

revision = "a7b8c9d0e1f2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "scan_configs",
        sa.Column(
            "anomaly_detection_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "scan_configs",
        sa.Column(
            "detect_project_total",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "scan_configs",
        sa.Column(
            "detect_event_types",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "scan_configs",
        sa.Column(
            "detect_events",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "scan_configs",
        sa.Column(
            "baseline_window_buckets",
            sa.Integer(),
            nullable=False,
            server_default="14",
        ),
    )
    op.add_column(
        "scan_configs",
        sa.Column(
            "min_history_buckets",
            sa.Integer(),
            nullable=False,
            server_default="7",
        ),
    )
    op.add_column(
        "scan_configs",
        sa.Column(
            "sigma_threshold",
            sa.Float(),
            nullable=False,
            server_default="3.0",
        ),
    )
    op.add_column(
        "scan_configs",
        sa.Column(
            "min_expected_count",
            sa.Integer(),
            nullable=False,
            server_default="10",
        ),
    )

    op.create_table(
        "metric_anomalies",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("scope_ref", sa.String(length=64), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("event_type_id", sa.Uuid(), nullable=True),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("actual_count", sa.BigInteger(), nullable=False),
        sa.Column("expected_count", sa.Float(), nullable=False),
        sa.Column("stddev", sa.Float(), nullable=False),
        sa.Column("z_score", sa.Float(), nullable=False),
        sa.Column("direction", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["event_type_id"], ["event_types.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "bucket",
            name="uq_metric_anomaly_scope_bucket",
        ),
    )
    op.create_index(
        "ix_metric_anomaly_scope_bucket",
        "metric_anomalies",
        ["scan_config_id", "scope_type", "scope_ref", "bucket"],
    )
    op.create_index(
        "ix_metric_anomaly_event_bucket",
        "metric_anomalies",
        ["event_id", "bucket"],
    )
    op.create_index(
        "ix_metric_anomaly_type_bucket",
        "metric_anomalies",
        ["event_type_id", "bucket"],
    )


def downgrade() -> None:
    op.drop_index("ix_metric_anomaly_type_bucket", table_name="metric_anomalies")
    op.drop_index("ix_metric_anomaly_event_bucket", table_name="metric_anomalies")
    op.drop_index("ix_metric_anomaly_scope_bucket", table_name="metric_anomalies")
    op.drop_table("metric_anomalies")

    op.drop_column("scan_configs", "min_expected_count")
    op.drop_column("scan_configs", "sigma_threshold")
    op.drop_column("scan_configs", "min_history_buckets")
    op.drop_column("scan_configs", "baseline_window_buckets")
    op.drop_column("scan_configs", "detect_events")
    op.drop_column("scan_configs", "detect_event_types")
    op.drop_column("scan_configs", "detect_project_total")
    op.drop_column("scan_configs", "anomaly_detection_enabled")
