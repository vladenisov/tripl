"""add 'value_drift' to alert_drift_type

Migration d1c2b3a4f5e6 added the variable-value-drift alert scope: it extended
``metric_scope_type`` with 'variable_value_drift' and added the
``include_variable_value_drifts`` rule toggle. It did NOT extend
``alert_drift_type``, which is the enum behind
``alert_delivery_items.drift_type`` — and the candidate builder writes
'value_drift' there (worker/tasks/metrics/signals.py).

So the first delivery for a rule with that toggle on fails the INSERT on the
enum, and because dispatch runs inside ``collect_metrics`` the whole collection
transaction for that scan config goes down with it — not just the alert.

The test suite runs on SQLite, which stores the enum as plain text and validates
nothing, which is why this shipped green (tripl-jfm3.97).

Revision ID: e2f3a4b5c6d7
Revises: d1e2f3a4b5c6
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e2f3a4b5c6d7"
down_revision: str | None = "d1e2f3a4b5c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        # ALTER TYPE ... ADD VALUE cannot run inside a transaction block, hence
        # the autocommit block. IF NOT EXISTS keeps a re-run after a failed
        # migration idempotent.
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE alert_drift_type ADD VALUE IF NOT EXISTS 'value_drift'")


def downgrade() -> None:
    # Postgres has no safe in-place DROP VALUE for an enum; the unused
    # 'value_drift' label is left in alert_drift_type (harmless), matching how
    # c3d4e5f6a7b8 handles the same situation for scan_job_status.
    pass
