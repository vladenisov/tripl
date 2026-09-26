"""add 'metric' value to alert_rule_filter_field

Revision ID: c5e1f7a2b9d4
Revises: b7d2e94f1a36
Create Date: 2026-09-26 10:00:00.000000

An alert rule can be narrowed to one catalog metric (JR-15): a ``metric``
filter lists MetricDefinition ids, matched against a ``metric``-scope signal's
``scope_ref``. Added in an autocommit block because Postgres cannot ``ALTER
TYPE ... ADD VALUE`` inside a transaction on every supported version.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "c5e1f7a2b9d4"
down_revision: str | None = "b7d2e94f1a36"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        # SQLite (tests) stores the enum as a plain string; nothing to alter.
        return

    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE alert_rule_filter_field ADD VALUE IF NOT EXISTS 'metric'")


def downgrade() -> None:
    # Postgres has no safe in-place DROP VALUE for an enum; the unused 'metric'
    # label is left in alert_rule_filter_field (harmless).
    pass
