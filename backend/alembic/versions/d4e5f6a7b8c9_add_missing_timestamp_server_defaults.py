"""add missing timestamp server defaults

Revision ID: d4e5f6a7b8c9
Revises: 1a2b3c4d5e6f
Create Date: 2026-07-16 09:00:00.000000

``TimestampMixin`` (``tripl.models.base``) declares ``server_default=func.now()``
on both ``created_at`` and ``updated_at``, so any table built from
``Base.metadata.create_all`` already carries the DB-side ``DEFAULT now()``.
Three tables, however, were created by earlier migrations that did *not* emit
that DEFAULT, so on a real (migration-built) database their ``created_at`` /
``updated_at`` columns are ``NOT NULL`` with no default and every INSERT that
omits them fails with a not-null violation. This model-vs-migration drift only
affects existing databases; a fresh model ``create_all`` would already be
correct.

This migration repairs the live columns by setting the missing DEFAULT on both
timestamp columns of:

- ``event_type_owners``
- ``alert_correlation_states``
- ``plan_branch_merge_resolutions``

SQLite cannot ``ALTER COLUMN ... SET DEFAULT`` and SQLite tests build the schema
from ``Base.metadata.create_all``; this migration only runs on PostgreSQL.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: str | None = "1a2b3c4d5e6f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES: tuple[str, ...] = (
    "event_type_owners",
    "alert_correlation_states",
    "plan_branch_merge_resolutions",
)
_COLUMNS: tuple[str, ...] = ("created_at", "updated_at")


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for table in _TABLES:
        for column in _COLUMNS:
            op.execute(sa.text(f"ALTER TABLE {table} ALTER COLUMN {column} SET DEFAULT now()"))


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for table in _TABLES:
        for column in _COLUMNS:
            op.execute(sa.text(f"ALTER TABLE {table} ALTER COLUMN {column} DROP DEFAULT"))
