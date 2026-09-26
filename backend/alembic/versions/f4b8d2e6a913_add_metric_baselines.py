"""add metric_baselines (per-bucket expected value and band for every scored bucket)

``metric_anomalies`` stores the expected value and stddev of FLAGGED buckets
only, so the metric chart could draw its baseline band on those alone
(tripl-i9mt.25). The metrics worker now writes one row per scored bucket of a
scan-scoped series (``project_total``, ``event_type``, ``event``), flagged or
not: the expected value and the floored effective stddev the z-score divides
by, so ``expected ± sigma_threshold * effective_stddev`` is the detector's own
boundary.

A table rather than nullable ``event_metrics`` columns: the project-total
series is a SUM over the event-type rows and has no row of its own to carry a
baseline. The key mirrors ``metric_anomalies`` for scan scopes, and the rows
go with their scan config (ON DELETE CASCADE).

No backfill. The table starts empty, so every bucket scored before this
migration has no baseline row, and the chart draws the band only on buckets
where one is present (plus, as before, on flagged buckets from their anomaly
row). A scheduled scan re-scores only its trailing evaluation window, so
only buckets inside each scan's evaluation window, plus any manually replayed
range, gain a baseline row; older history keeps flagged-only bands.

Revision ID: f4b8d2e6a913
Revises: d3f7a1c9e254
Create Date: 2026-09-26 20:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f4b8d2e6a913"
down_revision: str | None = "d3f7a1c9e254"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "metric_baselines",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column(
            "scope_type",
            # metric_scope_type already exists and is shared with
            # metric_anomalies, signal_triage and others.
            postgresql.ENUM(name="metric_scope_type", create_type=False),
            nullable=False,
        ),
        sa.Column("scope_ref", sa.String(length=64), nullable=False),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expected_count", sa.Float(), nullable=False),
        sa.Column("effective_stddev", sa.Float(), nullable=False),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "bucket",
            name="uq_metric_baseline_scope_bucket",
        ),
    )


def downgrade() -> None:
    # metric_scope_type is shared and stays.
    op.drop_table("metric_baselines")
