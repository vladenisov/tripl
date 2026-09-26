"""alert rules default min_percent_delta to 30 instead of 100

Revision ID: a4c8e2f61b93
Revises: e2b9f4c7a1d6
Create Date: 2026-09-26 10:15:00.000000

The gate is |actual - expected| / expected * 100, so a DROP reaches 100 % only
when volume falls to zero: at the old default a "tell me when X drops" rule
ignored a 50 % or a 90 % fall (AL-2). The rule editor already starts new rules
at 30; this moves the server default with it.

Only the column default changes. Existing rows keep the value they were saved
with — a stored 100 may be a deliberate choice, and nothing can tell the two
apart.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4c8e2f61b93"
down_revision: str | None = "e2b9f4c7a1d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "alert_rules",
        "min_percent_delta",
        existing_type=sa.Float(),
        server_default="30.0",
    )


def downgrade() -> None:
    op.alter_column(
        "alert_rules",
        "min_percent_delta",
        existing_type=sa.Float(),
        server_default="100.0",
    )
