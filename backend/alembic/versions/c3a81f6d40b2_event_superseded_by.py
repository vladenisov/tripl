"""name the event that replaced a retired one

Revision ID: c3a81f6d40b2
Revises: b7f4d02a91c6
Create Date: 2026-09-09 00:45:00.000000

An event could already be marked ``deprecated`` and given a ``sunset_at``, and
the catalog said when it stops without ever saying what to send instead — the
half of "link legacy events with new ones" that group rules do not answer
(tripl-h2sx.13).

A nullable self-FK, documentation only: nothing matches on it, collects
through it or counts coverage with it. ``SET NULL`` because deleting the
successor must not delete its predecessor, and a cleared pointer beats a
dangling one — the same choice ``events.owner_id`` made.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3a81f6d40b2"
down_revision: str | None = "b7f4d02a91c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("events", sa.Column("superseded_by_event_id", sa.Uuid(), nullable=True))
    op.create_index(
        "ix_events_superseded_by_event_id",
        "events",
        ["superseded_by_event_id"],
    )
    op.create_foreign_key(
        "fk_events_superseded_by_event_id_events",
        "events",
        "events",
        ["superseded_by_event_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_events_superseded_by_event_id_events", "events", type_="foreignkey")
    op.drop_index("ix_events_superseded_by_event_id", table_name="events")
    op.drop_column("events", "superseded_by_event_id")
