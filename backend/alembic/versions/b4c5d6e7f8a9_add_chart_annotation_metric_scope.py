"""add 'metric' value to chart_annotation_scope_type

Revision ID: b4c5d6e7f8a9
Revises: f9a0b1c2d3e4
Create Date: 2026-07-03 10:00:00.000000

Chart annotations gain a ``metric`` scope (ticket tripl-nxk2.13) so releases
and campaigns can be marked on catalog-metric charts. ``scope_ref`` holds the
MetricDefinition id, mirroring how ``event``/``event_type`` scopes reference
their series. Added in an autocommit block because Postgres cannot ``ALTER
TYPE ... ADD VALUE`` inside a transaction on every supported version.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "b4c5d6e7f8a9"
down_revision: str | None = "f9a0b1c2d3e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        # SQLite (tests) stores the enum as a plain string; nothing to alter.
        return

    # ALTER TYPE ... ADD VALUE cannot run inside a transaction block on every
    # supported Postgres version; do it in an autocommit block.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE chart_annotation_scope_type ADD VALUE IF NOT EXISTS 'metric'")


def downgrade() -> None:
    # Postgres has no safe in-place DROP VALUE for an enum; the unused 'metric'
    # label is left in chart_annotation_scope_type (harmless).
    pass
