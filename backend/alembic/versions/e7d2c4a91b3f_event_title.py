"""event title beside the scan identity

Revision ID: e7d2c4a91b3f
Revises: c4a7e9b21d63
Create Date: 2026-09-07 12:00:00.000000

``events.name`` is the scan identity whenever a naming rule governs the event
type — ``create_event`` overwrites whatever a person typed with the derived
name — so there was nowhere for the label an analyst actually thinks in
("Tap on a model card") except ``description``, or ``name`` itself on a
branch where the rule failed to resolve (tripl-kjhi.1). ``title`` is that
label: free text, empty by default, never part of the identity and never
substituted for it (tripl-kjhi.3).

NOT NULL with a server default of the empty string, like ``description``
before it, so the column reads the same on every row and the ORM default
(``""``) and the database default agree.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7d2c4a91b3f"
down_revision: str | None = "c4a7e9b21d63"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "events",
        sa.Column("title", sa.String(length=500), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("events", "title")
