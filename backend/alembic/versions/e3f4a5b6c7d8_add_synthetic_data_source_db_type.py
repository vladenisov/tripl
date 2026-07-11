"""add synthetic data source db type

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
Create Date: 2026-07-11 12:00:00.000000

* ``data_source_db_type`` gains ``'synthetic'`` (autocommit block — Postgres
  cannot ``ALTER TYPE ... ADD VALUE`` inside a transaction on every supported
  version; mirrors a1b2c3d4e5f6 / d1c2b3a4f5e6).

The value backs the local in-memory synthetic warehouse used by generated demo
projects (epic tripl-2su6.3). No column, table, or data change — only the enum
domain widens, so downgrade is a no-op (Postgres cannot drop enum values).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e3f4a5b6c7d8"
down_revision: str | None = "d2e3f4a5b6c7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE data_source_db_type ADD VALUE IF NOT EXISTS 'synthetic'")


def downgrade() -> None:
    # The enum value is left in place (Postgres cannot drop enum values).
    pass
