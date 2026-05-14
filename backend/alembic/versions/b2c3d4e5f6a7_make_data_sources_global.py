"""make data sources global and add project_id to scan_configs

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-04-05 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Add project_id to scan_configs (copy from data_source before dropping)
    op.add_column(
        "scan_configs",
        sa.Column("project_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "fk_scan_configs_project_id",
        "scan_configs",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # Backfill project_id from data_sources
    op.execute(
        """
        UPDATE scan_configs
        SET project_id = data_sources.project_id
        FROM data_sources
        WHERE scan_configs.data_source_id = data_sources.id
        """
    )

    # Make project_id non-nullable after backfill
    op.alter_column("scan_configs", "project_id", nullable=False)

    # Drop project_id from data_sources
    op.drop_constraint("uq_data_source_project_name", "data_sources", type_="unique")
    op.drop_constraint("data_sources_project_id_fkey", "data_sources", type_="foreignkey")
    op.drop_column("data_sources", "project_id")

    # Add new global unique constraint on data source name
    op.create_unique_constraint("uq_data_source_name", "data_sources", ["name"])


def downgrade() -> None:
    # Re-add project_id to data_sources
    op.drop_constraint("uq_data_source_name", "data_sources", type_="unique")
    op.add_column(
        "data_sources",
        sa.Column("project_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "data_sources_project_id_fkey",
        "data_sources",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # Backfill from scan_configs
    op.execute(
        """
        UPDATE data_sources
        SET project_id = (
            SELECT scan_configs.project_id
            FROM scan_configs
            WHERE scan_configs.data_source_id = data_sources.id
            LIMIT 1
        )
        """
    )

    op.create_unique_constraint(
        "uq_data_source_project_name", "data_sources", ["project_id", "name"]
    )

    # Drop project_id from scan_configs
    op.drop_constraint("fk_scan_configs_project_id", "scan_configs", type_="foreignkey")
    op.drop_column("scan_configs", "project_id")
