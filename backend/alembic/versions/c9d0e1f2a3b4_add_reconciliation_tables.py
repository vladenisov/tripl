"""add shadow event candidates and coverage metrics

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-06-10 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c9d0e1f2a3b4"
down_revision: str | None = "b8c9d0e1f2a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "shadow_event_candidates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column("event_type_id", sa.Uuid(), nullable=True),
        sa.Column("event_name", sa.String(length=500), nullable=False),
        sa.Column("observed_count", sa.BigInteger(), nullable=False),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("accepted_event_id", sa.Uuid(), nullable=True),
        sa.Column("resolved_by", sa.Uuid(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["event_type_id"], ["event_types.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["accepted_event_id"], ["events.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["resolved_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scan_config_id",
            "event_name",
            name="uq_shadow_candidate_config_name",
        ),
    )
    op.create_index(
        "ix_shadow_candidate_project_status",
        "shadow_event_candidates",
        ["project_id", "status"],
    )

    op.create_table(
        "coverage_metrics",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("total_count", sa.BigInteger(), nullable=False),
        sa.Column("matched_count", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scan_config_id",
            "bucket",
            name="uq_coverage_metric_config_bucket",
        ),
    )
    op.create_index(
        "ix_coverage_metric_config_bucket",
        "coverage_metrics",
        ["scan_config_id", "bucket"],
    )


def downgrade() -> None:
    op.drop_index("ix_coverage_metric_config_bucket", table_name="coverage_metrics")
    op.drop_table("coverage_metrics")
    op.drop_index("ix_shadow_candidate_project_status", table_name="shadow_event_candidates")
    op.drop_table("shadow_event_candidates")
