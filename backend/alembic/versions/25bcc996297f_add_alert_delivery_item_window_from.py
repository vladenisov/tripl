"""add alert_delivery_items.window_from

Release-regression alert items are measured over the activation-anchored
rollout-overlap window, not over the scan bucket. ``bucket`` already stores the
window's end; this column stores its start so the rendered message can name the
window it compared. Snapshotted per item because the source ReleaseRegression
rows are deleted and recomputed on every scan, so a delivery retried from the
Inbox could not read the window back.

Nullable with no backfill: every other scope's window IS its bucket, and items
delivered before this migration simply render without the window clause.

Revision ID: 25bcc996297f
Revises: c8d9e0f1a2b3
Create Date: 2026-08-07
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "25bcc996297f"
down_revision = "c8d9e0f1a2b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "alert_delivery_items",
        sa.Column("window_from", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("alert_delivery_items", "window_from")
