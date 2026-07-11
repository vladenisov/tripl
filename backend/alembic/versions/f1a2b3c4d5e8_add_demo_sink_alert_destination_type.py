"""add demo_sink alert destination type

Revision ID: f1a2b3c4d5e8
Revises: e3f4a5b6c7d8
Create Date: 2026-07-11 13:00:00.000000

* ``alert_destination_type`` gains ``'demo_sink'`` (autocommit block — Postgres
  cannot ``ALTER TYPE ... ADD VALUE`` inside a transaction on every supported
  version; mirrors e3f4a5b6c7d8 / d1c2b3a4f5e6).

``demo_sink`` is the local, non-sendable alert destination used by generated
demo projects (epic tripl-2su6.6): the dispatch worker renders the message and
records the delivery locally, performing no outbound network send. No column,
table, or data change — only the enum domain widens, so downgrade is a no-op
(Postgres cannot drop enum values).
"""

from collections.abc import Sequence

from alembic import op

revision: str = "f1a2b3c4d5e8"
down_revision: str | None = "e3f4a5b6c7d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE alert_destination_type ADD VALUE IF NOT EXISTS 'demo_sink'")


def downgrade() -> None:
    # The enum value is left in place (Postgres cannot drop enum values).
    pass
