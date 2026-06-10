"""add field contract rules

Revision ID: f6a7b8c9d0e1
Revises: 5f6e7d8c9b0a
Create Date: 2026-06-10 13:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f6a7b8c9d0e1"
down_revision: str | None = "5f6e7d8c9b0a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "field_definitions",
        sa.Column("contract_required_max_null_rate", sa.Float(), nullable=True),
    )
    op.add_column(
        "field_definitions",
        sa.Column("contract_regex", sa.String(length=500), nullable=True),
    )
    op.add_column(
        "field_definitions",
        sa.Column("contract_min_value", sa.Float(), nullable=True),
    )
    op.add_column(
        "field_definitions",
        sa.Column("contract_max_value", sa.Float(), nullable=True),
    )
    op.add_column(
        "field_definitions",
        sa.Column("contract_max_bad_rate", sa.Float(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("field_definitions", "contract_max_bad_rate")
    op.drop_column("field_definitions", "contract_max_value")
    op.drop_column("field_definitions", "contract_min_value")
    op.drop_column("field_definitions", "contract_regex")
    op.drop_column("field_definitions", "contract_required_max_null_rate")
