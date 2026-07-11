"""add demo runtime tick + access timestamps

Revision ID: f2a3b4c5d6e7
Revises: f1a2b3c4d5e8
Create Date: 2026-07-11 19:00:00.000000

Epic tripl-2su6.7 — keep an active demo fresh after creation with a scheduled,
bounded, idempotent runtime tick. Two additive, nullable columns on ``projects``:

* ``demo_last_tick_at`` — when the tick last advanced the demo's synthetic clock
  (diagnostic; correctness comes from the seeded series + unique constraints).
* ``demo_last_accessed_at`` — last explicit demo activity, so the tick can pause
  demos nobody is looking at and resume them on next access.

Both are NULL for real projects and for freshly-seeded demos. SQLite (tests)
builds the schema from ``Base.metadata.create_all``; this migration only runs on
PostgreSQL.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2a3b4c5d6e7"
down_revision: str | None = "f1a2b3c4d5e8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.add_column(
        "projects", sa.Column("demo_last_tick_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "projects",
        sa.Column("demo_last_accessed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.drop_column("projects", "demo_last_accessed_at")
    op.drop_column("projects", "demo_last_tick_at")
