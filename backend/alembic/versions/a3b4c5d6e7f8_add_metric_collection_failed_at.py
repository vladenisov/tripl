"""Add metric_definitions.last_collection_failed_at

The catalog-metric dispatcher's post-error cooldown measured elapsed time from
``updated_at``. ``TimestampMixin`` declares ``onupdate=func.now()``, so any write
to the row moved it — and ``update_metric_definition`` is a write, which meant an
operator editing a broken metric in order to FIX it restarted the cooldown they
were waiting out. This column is written only by the collection cycle, so it
means what the backoff reads it as (tripl-os3v).

Nullable with no backfill, deliberately. Rows already sitting in the error state
carry no recorded failure time, and inventing one would either release them all
at deploy — a retry storm on the first tick, the thing the backoff exists to
prevent — or hold them for a cooldown they have already served.
``_metric_definition_error_backoff`` falls back to ``updated_at`` while the
column is NULL, so existing rows keep exactly today's behaviour until their next
real failure stamps it.

Revision ID: a3b4c5d6e7f8
Revises: e2f3a4b5c6d7
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3b4c5d6e7f8"
down_revision: str | None = "e2f3a4b5c6d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "metric_definitions",
        sa.Column("last_collection_failed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("metric_definitions", "last_collection_failed_at")
