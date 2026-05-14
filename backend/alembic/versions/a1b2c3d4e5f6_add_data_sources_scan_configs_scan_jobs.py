"""add data_sources, scan_configs, scan_jobs tables

Revision ID: a1b2c3d4e5f6
Revises: d10614acc200
Create Date: 2026-04-05 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "d10614acc200"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "data_sources",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("db_type", sa.String(length=20), nullable=False),
        sa.Column("host", sa.String(length=500), nullable=False),
        sa.Column("port", sa.Integer(), nullable=False),
        sa.Column("database_name", sa.String(length=255), nullable=False),
        sa.Column("username", sa.String(length=255), nullable=False),
        sa.Column("password_encrypted", sa.Text(), nullable=False),
        sa.Column("extra_params", sa.JSON(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "name", name="uq_data_source_project_name"),
    )

    op.create_table(
        "scan_configs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("data_source_id", sa.Uuid(), nullable=False),
        sa.Column("event_type_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("base_query", sa.Text(), nullable=False),
        sa.Column("event_type_column", sa.String(length=255), nullable=True),
        sa.Column("cardinality_threshold", sa.Integer(), nullable=False),
        sa.Column("schedule", sa.String(length=100), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["data_source_id"], ["data_sources.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["event_type_id"], ["event_types.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("data_source_id", "name", name="uq_scan_config_ds_name"),
    )

    op.create_table(
        "scan_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_summary", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("scan_jobs")
    op.drop_table("scan_configs")
    op.drop_table("data_sources")
