"""add variable excluded_from_scans

Revision ID: f5e6d7c8b9a0
Revises: d1c2b3a4f5e6
Create Date: 2026-07-10 16:00:00.000000

Plain variable deletion is undone by the next scan (ensure_variable
re-creates unmatched tokens). The excluded flag keeps the row as a tombstone:
scans adopt-and-skip it — no re-creation, no observed contexts, no drift.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f5e6d7c8b9a0"
down_revision: str | None = "d1c2b3a4f5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "variables",
        sa.Column(
            "excluded_from_scans",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("variables", "excluded_from_scans")
