"""add data source json_path_discovery

Revision ID: c4d5e6f7a8b1
Revises: b3c4d5e6f7a9
Create Date: 2026-06-29 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4d5e6f7a8b1"
down_revision: str | None = "b3c4d5e6f7a9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "data_sources",
        sa.Column("json_path_discovery", sa.String(length=16), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("data_sources", "json_path_discovery")
