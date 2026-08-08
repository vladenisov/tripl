"""add scan dry run jobs

Revision ID: 1c9d4b7e0a25
Revises: 25bcc996297f
Create Date: 2026-08-08 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "1c9d4b7e0a25"
down_revision: str | None = "25bcc996297f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scan_dry_run_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=True),
        sa.Column("data_source_id", sa.Uuid(), nullable=True),
        sa.Column("base_query", sa.Text(), nullable=True),
        sa.Column("event_type_id", sa.Uuid(), nullable=True),
        sa.Column("event_type_column", sa.String(length=255), nullable=True),
        sa.Column("time_column", sa.String(length=255), nullable=True),
        sa.Column("event_name_format", sa.String(length=500), nullable=True),
        sa.Column("event_group_rules", sa.JSON(), nullable=False),
        sa.Column("json_value_paths", sa.JSON(), nullable=False),
        sa.Column("cardinality_threshold", sa.Integer(), nullable=False),
        sa.Column("app_version_column", sa.String(length=255), nullable=True),
        sa.Column("platform_column", sa.String(length=255), nullable=True),
        sa.Column("scan_lookback_hours", sa.Integer(), nullable=True),
        sa.Column("sample_row_limit", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_summary", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["event_type_id"], ["event_types.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_scan_dry_run_job_project", "scan_dry_run_jobs", ["project_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_scan_dry_run_job_project", table_name="scan_dry_run_jobs")
    op.drop_table("scan_dry_run_jobs")
