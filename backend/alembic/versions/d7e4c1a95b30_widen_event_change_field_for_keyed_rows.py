"""widen event_changes.field so a keyed history row fits

Revision ID: d7e4c1a95b30
Revises: f4a8d3c72e19
Create Date: 2026-09-21 10:00:00.000000

``event_changes.field`` has held ``String(100)`` since the table was created
(e0f1a2b3c4d5). Since tripl-kjhi.9 the history also records per-field and
per-meta-field value edits, and those rows are KEYED: ``event_service`` writes
``field:<field name>`` and ``meta:<meta field name>``. Both name columns are
``String(100)`` and both create schemas accept the full 100, so the key can be
106 characters. Editing the value of a field whose name is 95 characters or
longer therefore raised StringDataRightTruncation at flush on PostgreSQL and the
whole save was rolled back as a 500 (tripl-0zpq.256). SQLite does not enforce
VARCHAR widths, which is why no test saw it.

255, not a tight 106, so a longer prefix or a wider name column does not reopen
the same hole. Widening a varchar is a metadata-only change in PostgreSQL — no
table rewrite and no long lock.

The downgrade narrows the column back and would fail on any row that has since
been written longer than 100 characters, so it truncates those rows first: a
history entry's key is display text, and a truncated key still reads as the
field it names. Losing the tail is the only way back down that does not abort.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7e4c1a95b30"
down_revision: str | None = "f4a8d3c72e19"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "event_changes",
        "field",
        existing_type=sa.String(length=100),
        type_=sa.String(length=255),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.execute(
        sa.text("UPDATE event_changes SET field = substr(field, 1, 100) WHERE length(field) > 100")
    )
    op.alter_column(
        "event_changes",
        "field",
        existing_type=sa.String(length=255),
        type_=sa.String(length=100),
        existing_nullable=False,
    )
