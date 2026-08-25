"""add branch context to audit_log

Revision ID: c3f1a9e07d24
Revises: e5c7a91b3d02
Create Date: 2026-08-25 10:00:00.000000

PR #143 made ``?branch=`` a first-class parameter on 48 routes, so a write to a
working branch became an ordinary, discoverable operation — but the audit row
had nowhere to say which branch it happened on, and two contradictory edits to
the same object on two branches produced two identical-looking rows
(tripl-wkwv.6).

``branch_name`` is denormalized next to the id for the same reason
``user_email`` and ``project_slug`` are: deleting a branch hard-deletes its row
and this FK is ``ON DELETE SET NULL``, which would erase the branch context from
exactly the rows that recorded that branch's work.

No backfill, because there is nothing to backfill from — not because the history
is clean. ``?branch=`` has been functional on these write routes since 749c209
(#143 only made it visible in the OpenAPI schema), so a row predating this
migration may well be a branch-scoped write; the branch it targeted was simply
never recorded and cannot be recovered. NULL is defined as "not written through
a branch-scoped request", which also covers the actions that have no plan-branch
dimension at all (alerting, scans, data sources, users, API keys); on a
pre-migration row it means "unknown". Backfilling a synthetic main id would
assert something false about both groups.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3f1a9e07d24"
down_revision: str | None = "e5c7a91b3d02"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_FK_NAME = "fk_audit_log_branch"
_INDEX_NAME = "ix_audit_log_branch"


def upgrade() -> None:
    # Both adds are safe on a populated table with no rewrite: a nullable column
    # needs no value, and Postgres 11+ stores a NOT NULL column's server default
    # in the catalogue instead of rewriting every row. No row can violate either.
    op.add_column("audit_log", sa.Column("branch_id", sa.Uuid(), nullable=True))
    op.add_column(
        "audit_log",
        sa.Column("branch_name", sa.String(length=255), server_default="", nullable=False),
    )
    op.create_foreign_key(
        _FK_NAME,
        "audit_log",
        "plan_branches",
        ["branch_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # Not decoration: without it, deleting a branch (or a project, which cascades
    # to its branches) seq-scans the whole append-only audit log to apply the
    # SET NULL above.
    op.create_index(_INDEX_NAME, "audit_log", ["branch_id"])


def downgrade() -> None:
    # Safe on a populated database, and the delete-then-narrow rule that bit the
    # last three downgrades genuinely does not apply: this only DROPS. It narrows
    # no column and adds no constraint, so there are no violating rows to clear
    # first. The order is load-bearing — the index and the constraint both
    # reference ``branch_id`` and must go before it does.
    op.drop_index(_INDEX_NAME, table_name="audit_log")
    op.drop_constraint(_FK_NAME, "audit_log", type_="foreignkey")
    op.drop_column("audit_log", "branch_name")
    op.drop_column("audit_log", "branch_id")
