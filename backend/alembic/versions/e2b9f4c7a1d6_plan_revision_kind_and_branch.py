"""plan revisions record their kind and branch

Revision ID: e2b9f4c7a1d6
Revises: d8a3c6e1f2b7
Create Date: 2026-09-26 10:10:00.000000

History told a merge and a branch's merge base apart only by parsing
``summary`` ("Merged branch 'x'" / "Base snapshot for branch 'x'") and then
resolving the branch by name (PL-21). ``kind`` and ``branch_id`` store both.

Backfill: a revision some branch names as ``base_revision_id`` is that branch's
``branch_base``; one whose summary is exactly the merge service's text for a
MERGED branch of the same project is that branch's ``merge``. Branch names are
unique per project, so the match is at most one row. The summary is never
pattern-matched on its own: a revision whose quoted branch is gone, or a user
snapshot that only reads like a merge, stays a ``snapshot`` — the column exists
so that free text is not parsed for meaning.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e2b9f4c7a1d6"
down_revision: str | None = "d8a3c6e1f2b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ENUM_NAME = "plan_revision_kind"
_FK_NAME = "fk_plan_revisions_branch_id"

# Module-level so the backfill can be tested on its own: it is plain SQL that
# SQLite runs too, without the PostgreSQL-only enum DDL around it.
BACKFILL_BRANCH_BASE = (
    "UPDATE plan_revisions SET kind = 'branch_base', branch_id = ("
    " SELECT pb.id FROM plan_branches pb"
    " WHERE pb.base_revision_id = plan_revisions.id LIMIT 1"
    ") WHERE EXISTS ("
    " SELECT 1 FROM plan_branches pb WHERE pb.base_revision_id = plan_revisions.id"
    ")"
)

# ``kind`` and ``branch_id`` come from ONE join, so a revision becomes a merge
# only when a merged branch of its own project carries the name its summary
# quotes. ``summary`` is free text: matching "Merged branch '%'" on its own
# would stamp a user's look-alike snapshot as a merge for good. ``main`` is
# stored as ``merged`` too but is never merged INTO anything, so it is excluded.
_MERGED_BRANCH_OF_REVISION = (
    " FROM plan_branches pb"
    " WHERE pb.project_id = plan_revisions.project_id"
    " AND pb.status = 'merged'"
    " AND pb.kind <> 'main'"
    " AND plan_revisions.summary = 'Merged branch ''' || pb.name || ''''"
)
BACKFILL_MERGE = (
    "UPDATE plan_revisions SET kind = 'merge', branch_id = ("
    " SELECT pb.id" + _MERGED_BRANCH_OF_REVISION + " LIMIT 1"
    ") WHERE kind = 'snapshot' AND EXISTS ("
    " SELECT 1" + _MERGED_BRANCH_OF_REVISION + ")"
)


def upgrade() -> None:
    bind = op.get_bind()
    postgresql.ENUM("snapshot", "branch_base", "merge", name=_ENUM_NAME).create(
        bind, checkfirst=True
    )
    op.add_column(
        "plan_revisions",
        sa.Column(
            "kind",
            postgresql.ENUM("snapshot", "branch_base", "merge", name=_ENUM_NAME, create_type=False),
            server_default=sa.text("'snapshot'"),
            nullable=False,
        ),
    )
    op.add_column("plan_revisions", sa.Column("branch_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        _FK_NAME,
        "plan_revisions",
        "plan_branches",
        ["branch_id"],
        ["id"],
        ondelete="SET NULL",
    )

    op.execute(sa.text(BACKFILL_BRANCH_BASE))
    op.execute(sa.text(BACKFILL_MERGE))


def downgrade() -> None:
    op.drop_constraint(_FK_NAME, "plan_revisions", type_="foreignkey")
    op.drop_column("plan_revisions", "branch_id")
    op.drop_column("plan_revisions", "kind")
    postgresql.ENUM(name=_ENUM_NAME).drop(op.get_bind(), checkfirst=True)
