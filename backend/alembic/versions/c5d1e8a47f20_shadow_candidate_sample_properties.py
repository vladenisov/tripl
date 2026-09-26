"""shadow event candidates keep sample properties

Revision ID: c5d1e8a47f20
Revises: a4c8e2f61b93
Create Date: 2026-09-26 14:00:00.000000

The shadow inbox showed only a raw identity, a count and a type, so a reviewer
accepted an event into the plan without seeing what it looks like (DA-32). The
metrics collector now keeps up to five sample property dicts per candidate from
the rows that produced it. Existing rows start empty and fill on the next
collection that observes them.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5d1e8a47f20"
down_revision: str | None = "a4c8e2f61b93"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "shadow_event_candidates",
        sa.Column("sample_properties", sa.JSON(), server_default="[]", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("shadow_event_candidates", "sample_properties")
