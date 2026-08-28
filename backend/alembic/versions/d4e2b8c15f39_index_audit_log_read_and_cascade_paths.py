"""index the audit_log read and cascade paths

Revision ID: d4e2b8c15f39
Revises: c3f1a9e07d24
Create Date: 2026-08-27 12:00:00.000000

``audit_log`` carried exactly one index — ``branch_id``, added by the previous
revision because a branch delete otherwise seq-scans the whole table to apply its
``SET NULL``. The same argument was never applied to the two accesses that happen
far more often (tripl-wkwv.20).

THE READ PATH. ``audit_service.list_entries`` filters on ``project_slug`` on every
load of the only audit surface in the product, then runs a SECOND query with the
same predicate to count rows for the pager, and orders by
``created_at DESC, id DESC``. Unindexed, that is two full scans of an append-only
table plus a sort, on a page an owner opens precisely when something has gone
wrong. It is fast in every test — the suite's tables hold tens of rows — and gets
linearly slower for the life of the deployment.

The composite is ASCENDING although the query reads descending: a btree is
scanned equally well in either direction provided EVERY sort column is reversed
together, which these are. ``id`` is carried as the third column because the
pager's order is ``(created_at DESC, id DESC)`` — ``created_at`` alone is not a
total order, since ``server_default=now()`` gives every row of one batch a
byte-identical value (tripl-5ydt) — so including it lets the index satisfy the
whole sort rather than leaving one on top.

THE CASCADE PATH. ``project_id`` is ``ON DELETE SET NULL``, so deleting any
project scans this table to null it out: the branch argument one level up. Not
claimed for the demo reset's purge (tripl-wkwv.16) — that predicate ORs across two
columns and the second half is unindexed, so a scan is the honest expectation
there, and a reset is rare enough to pay it.

Both are pure additions: nothing is rewritten, no column is narrowed and no
constraint is added, so there are no violating rows to clear first and the
delete-then-narrow rule earlier downgrades keep tripping over does not apply.

``CREATE INDEX`` takes a lock that blocks writes to ``audit_log`` for its
duration, and this is deliberately NOT ``CONCURRENTLY``: that form cannot run
inside a transaction, and the deploy runs migrations as a one-shot that must exit
0 before the app is allowed to serve, so there is nothing writing to block.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "d4e2b8c15f39"
down_revision: str | None = "c3f1a9e07d24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_READ_INDEX = "ix_audit_log_project_slug_created"
_PROJECT_INDEX = "ix_audit_log_project"


def upgrade() -> None:
    op.create_index(_READ_INDEX, "audit_log", ["project_slug", "created_at", "id"])
    op.create_index(_PROJECT_INDEX, "audit_log", ["project_id"])


def downgrade() -> None:
    op.drop_index(_PROJECT_INDEX, table_name="audit_log")
    op.drop_index(_READ_INDEX, table_name="audit_log")
