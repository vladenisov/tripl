"""a comment can hang on the event, not only on one of its attachments

Revision ID: a2e5c19f7b34
Revises: f3a9b7c15d2e
Create Date: 2026-09-08 22:10:00.000000

The discussion object already shipped — threaded, authored, with its own API
and a fix (tripl-zjmo) so that commenting does not void a branch approval —
but the FK was ``photo_id`` and nothing else, so there was no comment surface
until someone attached a photo, and even then it lived inside a viewer modal
on a different page from the one where events are authored (tripl-h2sx.25).

Re-anchor rather than build a second table: ``photo_id`` becomes nullable and
``event_id`` joins it, with a CHECK that exactly one is set. Every existing row
keeps its ``photo_id``, so the constraint holds on the current data with no
backfill. Everything that means "the attachment threads" already filters on
``photo_id`` — the plan snapshot, the branch deep copy, the merge carry-back —
so an event thread is invisible to all of them, which is the point: it is
discussion, not plan content.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a2e5c19f7b34"
down_revision: str | None = "f3a9b7c15d2e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "event_photo_comments",
        sa.Column("event_id", sa.Uuid(), nullable=True),
    )
    op.alter_column("event_photo_comments", "photo_id", existing_type=sa.Uuid(), nullable=True)
    op.create_foreign_key(
        "fk_event_photo_comment_event",
        "event_photo_comments",
        "events",
        ["event_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_event_photo_comment_event", "event_photo_comments", ["event_id"])
    op.create_check_constraint(
        "ck_event_photo_comment_one_anchor",
        "event_photo_comments",
        "(photo_id IS NULL) <> (event_id IS NULL)",
    )


def downgrade() -> None:
    # Event-anchored rows have no photo to fall back to, and photo_id is about
    # to be NOT NULL again, so they cannot survive the downgrade.
    op.execute(sa.text("DELETE FROM event_photo_comments WHERE event_id IS NOT NULL"))
    op.drop_constraint("ck_event_photo_comment_one_anchor", "event_photo_comments", type_="check")
    op.drop_index("ix_event_photo_comment_event", table_name="event_photo_comments")
    op.drop_constraint("fk_event_photo_comment_event", "event_photo_comments", type_="foreignkey")
    op.alter_column("event_photo_comments", "photo_id", existing_type=sa.Uuid(), nullable=False)
    op.drop_column("event_photo_comments", "event_id")
