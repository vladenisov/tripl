"""add event field value authored flag

Revision ID: e9d8c7b6a5f4
Revises: f0e1d2c3b4a5
Create Date: 2026-07-09 00:00:00.000000

Existing field values deliberately remain unauthored. A heuristic backfill
would incorrectly protect scan-generated values, so user edits establish the
flag going forward.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e9d8c7b6a5f4"
down_revision: str | None = "f0e1d2c3b4a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "event_field_values",
        sa.Column("is_authored", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("event_field_values", "is_authored")
