"""resolution state on an event discussion thread

Revision ID: e5b19c74a208
Revises: c3a81f6d40b2
Create Date: 2026-09-09 01:30:00.000000

A question typed on an event never closed and could never be listed: neither
comment table had a status column, so the discussion tripl-h2sx.25 opened had
no way to end (tripl-h2sx.26).

The five columns are the ones ``schema_drifts`` and ``variable_value_drifts``
already carry, ``snoozed_until`` included — it is what keeps an open question
from becoming a permanent nag. The enum is its own type rather than a reuse of
``schema_drift_status``: a thread is open, resolved or snoozed, and a detector's
``accepted``/``false_positive`` verdicts are not things a question can be.

The columns are added to the whole table because event threads and photo threads
are one table; the service only lets a TOP-LEVEL comment carry an action.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e5b19c74a208"
down_revision: str | None = "c3a81f6d40b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ENUM_NAME = "event_comment_status"
_VALUES = ("open", "resolved", "snoozed")


def upgrade() -> None:
    bind = op.get_bind()
    postgresql.ENUM(*_VALUES, name=_ENUM_NAME).create(bind, checkfirst=True)
    status_enum = postgresql.ENUM(*_VALUES, name=_ENUM_NAME, create_type=False)
    op.add_column(
        "event_photo_comments",
        sa.Column(
            "status",
            status_enum,
            server_default=sa.text("'open'"),
            nullable=False,
        ),
    )
    op.add_column("event_photo_comments", sa.Column("resolution_note", sa.Text(), nullable=True))
    op.add_column(
        "event_photo_comments",
        sa.Column("snoozed_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "event_photo_comments",
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("event_photo_comments", sa.Column("resolved_by", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_event_photo_comments_resolved_by_users",
        "event_photo_comments",
        "users",
        ["resolved_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_event_photo_comment_event_status",
        "event_photo_comments",
        ["event_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_event_photo_comment_event_status", table_name="event_photo_comments")
    op.drop_constraint(
        "fk_event_photo_comments_resolved_by_users", "event_photo_comments", type_="foreignkey"
    )
    op.drop_column("event_photo_comments", "resolved_by")
    op.drop_column("event_photo_comments", "resolved_at")
    op.drop_column("event_photo_comments", "snoozed_until")
    op.drop_column("event_photo_comments", "resolution_note")
    op.drop_column("event_photo_comments", "status")
    postgresql.ENUM(name=_ENUM_NAME).drop(op.get_bind(), checkfirst=True)
