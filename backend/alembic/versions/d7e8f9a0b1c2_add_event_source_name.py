"""add event source_name (stable scan identity)

Revision ID: d7e8f9a0b1c2
Revises: c6d7e8f9a0b1
Create Date: 2026-06-02 18:40:00.000000

Events are deduplicated (and metrics are attached) by the name derived from the
scan's ``event_name_format`` columns. Keying on the editable display ``name``
meant that renaming an event made the next scan recreate it as a duplicate.

``source_name`` stores that derived name as a stable identity so ``name`` becomes
freely editable. Backfilled from the current ``name`` for existing rows (where
name has so far always equalled the scan identity).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "d7e8f9a0b1c2"
down_revision = "c6d7e8f9a0b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("events", sa.Column("source_name", sa.String(length=500), nullable=True))
    # Existing rows: name has always been the scan identity until now, so adopt it.
    op.execute("UPDATE events SET source_name = name WHERE source_name IS NULL")
    op.create_index(
        "ix_events_source_identity",
        "events",
        ["project_id", "event_type_id", "source_name"],
    )


def downgrade() -> None:
    op.drop_index("ix_events_source_identity", table_name="events")
    op.drop_column("events", "source_name")
