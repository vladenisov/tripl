"""reindex audit_log for the id-scoped and workspace-wide reads

Revision ID: e7a1c04b62d8
Revises: d4e2b8c15f39
Create Date: 2026-08-27 18:00:00.000000

The revision immediately before this one indexed ``(project_slug, created_at,
id)`` because that was exactly how ``audit_service.list_entries`` read. Then
tripl-wkwv.18 changed the predicate: the slug is resolved to a project and the
filter matches ``project_id``, falling back to the label only when no live
project answers to that slug. A btree cannot serve a predicate its leading column
is absent from, so the index bought one revision ago stopped covering the query
it was bought for — the project audit tab quietly went back to a top-N sort per
page, which is the exact failure that migration existed to remove.

And tripl-wkwv.17 added a second reader with no predicate at all: the
workspace-wide audit view sorts the entire table on every load.

So the read paths are three now, and each gets its filter column in front of the
sort:

  (project_id, created_at, id)   one project's log — the common case, and a
                                 prefix that also serves the ON DELETE SET NULL
                                 cascade, which is why the standalone
                                 ``ix_audit_log_project`` is dropped rather than
                                 kept alongside it;
  (project_slug, created_at, id) the fallback, for a slug no live project owns —
                                 a deleted project's rows keep the label and lose
                                 the id, so this is the only way back to them;
  (created_at, id)               the workspace feed, which filters by nothing.

Ascending in all three although the queries read descending: a btree is scanned
equally well in either direction provided every sort column is reversed together.
``id`` is carried because ``created_at`` is not a total order — one batch of rows
shares a ``server_default=now()`` value (tripl-5ydt).

Pure index work: nothing is rewritten, no column narrowed, no constraint added.
``CREATE INDEX`` locks writes for its duration and is deliberately not
``CONCURRENTLY`` — that form cannot run inside a transaction, and the deploy runs
migrations as a one-shot that must exit 0 before the app serves, so there is
nothing writing to block.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e7a1c04b62d8"
down_revision: str | None = "d4e2b8c15f39"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PROJECT_READ_INDEX = "ix_audit_log_project_created"
_FEED_INDEX = "ix_audit_log_created"
_SUPERSEDED_PROJECT_INDEX = "ix_audit_log_project"


def upgrade() -> None:
    op.create_index(_PROJECT_READ_INDEX, "audit_log", ["project_id", "created_at", "id"])
    op.create_index(_FEED_INDEX, "audit_log", ["created_at", "id"])
    # Superseded, not merely redundant: every query that used it is served by the
    # composite above, whose first column it is.
    op.drop_index(_SUPERSEDED_PROJECT_INDEX, table_name="audit_log")


def downgrade() -> None:
    op.create_index(_SUPERSEDED_PROJECT_INDEX, "audit_log", ["project_id"])
    op.drop_index(_FEED_INDEX, table_name="audit_log")
    op.drop_index(_PROJECT_READ_INDEX, table_name="audit_log")
