"""add pg_trgm GIN indexes for events substring filters

Speeds up the ILIKE substring filters in list_events on
events.name / events.description / events.source_name, which otherwise
trigger a full scan per filtered list. PostgreSQL-only; SQLite (tests) and
other backends are skipped.

Revision ID: 5f6e7d8c9b0a
Revises: 4f5e6d7c8b9a
Create Date: 2026-06-10 12:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "5f6e7d8c9b0a"
down_revision: str | None = "4f5e6d7c8b9a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_events_name_trgm ON events USING gin (name gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_events_description_trgm "
        "ON events USING gin (description gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_events_source_name_trgm "
        "ON events USING gin (source_name gin_trgm_ops)"
    )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute("DROP INDEX IF EXISTS ix_events_source_name_trgm")
    op.execute("DROP INDEX IF EXISTS ix_events_description_trgm")
    op.execute("DROP INDEX IF EXISTS ix_events_name_trgm")
