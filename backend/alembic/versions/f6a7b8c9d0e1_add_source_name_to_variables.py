"""add source_name to variables

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-04-08
"""

import sqlalchemy as sa
from alembic import op

revision = "f6a7b8c9d0e1"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "variables",
        sa.Column("source_name", sa.String(100), nullable=True),
    )
    # Backfill: set source_name = name for all existing variables
    op.execute("UPDATE variables SET source_name = name WHERE source_name IS NULL")
    # Unique constraint on (project_id, source_name)
    op.create_unique_constraint(
        "uq_variable_project_source_name", "variables", ["project_id", "source_name"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_variable_project_source_name", "variables", type_="unique")
    op.drop_column("variables", "source_name")
