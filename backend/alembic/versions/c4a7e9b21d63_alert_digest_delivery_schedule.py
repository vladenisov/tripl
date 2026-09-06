"""scheduled alert digests: destination cadence, project timezone, held-alert buffer

Revision ID: c4a7e9b21d63
Revises: 340d91a8825a
Create Date: 2026-09-05 12:00:00.000000

Alerts have only ever had one delivery moment: the end of the metrics
collection that produced them (``collect_metrics`` dispatches every delivery
``_prepare_alert_deliveries`` minted, worker/tasks/metrics/tasks.py). With
``check-metrics-due`` on a 300s beat that is a message per scan, and there was
no way to ask for anything else — the whole beat schedule is plain float
seconds and no cron expression existed anywhere in the codebase.

This revision adds the three pieces a cadence needs:

* ``alert_destinations.delivery_schedule_cron`` — NULL means IMMEDIATE, which
  is byte-identical to today's behaviour, so every existing destination keeps
  delivering exactly as it does now and nothing is backfilled. A 5-field cron
  expression otherwise.
* ``alert_destinations.last_flushed_at`` — the fire instant of the last window
  flushed, and the compare-and-set target the flusher claims a window with.
  NULL means never flushed.
* ``projects.timezone`` — the zone those cron expressions are read in.
  ``'UTC'`` reproduces the implicit behaviour of every project that predates
  the column, so the backfill is semantically a no-op.
* ``alert_pending_items`` — the buffer. A held alert is NOT a parked
  ``AlertDelivery``: ``requeue_stranded_alert_deliveries`` sweeps and sends any
  delivery left ``pending`` for 15 minutes, so parking one there would fail
  OPEN on a 15-minute fuse. Deliveries are minted only at flush time, which is
  also why ``alert_delivery_status``, the reaper's predicate, the Inbox and the
  four ``created_at``-ordered read paths are untouched by this change.

``uq_alert_pending_item_scope`` is what makes aggregation aggregate: a scope
re-firing on every collection upserts into ONE row carrying its latest numbers
instead of accumulating 24 duplicate lines. Its columns are
``_correlation_group_id``'s five plus the destination partition, so the
buffer's identity and the inbox's incident identity are the same thing.

No new enum TYPE is created — ``metric_scope_type``, ``anomaly_direction`` and
``alert_drift_type`` all already exist (``alert_delivery_items`` uses the same
three), so they are referenced with ``create_type=False`` and the downgrade has
no enum to leak.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c4a7e9b21d63"
down_revision: str | None = "340d91a8825a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "alert_pending_items"
_UNIQUE = "uq_alert_pending_item_scope"
_IX_DESTINATION = "ix_alert_pending_item_destination"
_IX_UPDATED = "ix_alert_pending_item_updated"


def _enum(name: str) -> postgresql.ENUM:
    """Reference an already-created enum type; never create or drop it here."""
    return postgresql.ENUM(name=name, create_type=False)


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    # ── The cadence, on the destination ───────────────────────────────────
    op.add_column(
        "alert_destinations",
        sa.Column("delivery_schedule_cron", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("last_flushed_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ── The zone the cadence is read in ───────────────────────────────────
    # NOT NULL with a server_default, so the ADD COLUMN is metadata-only and
    # every existing row reads 'UTC' without a table rewrite.
    op.add_column(
        "projects",
        sa.Column(
            "timezone",
            sa.String(length=64),
            server_default="UTC",
            nullable=False,
        ),
    )

    # ── The buffer ────────────────────────────────────────────────────────
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("destination_id", sa.Uuid(), nullable=False),
        sa.Column("rule_id", sa.Uuid(), nullable=False),
        sa.Column("scan_config_id", sa.Uuid(), nullable=False),
        sa.Column("scan_job_id", sa.Uuid(), nullable=True),
        sa.Column("source_anomaly_id", sa.Uuid(), nullable=True),
        sa.Column("scope_type", _enum("metric_scope_type"), nullable=False),
        sa.Column("scope_ref", sa.String(length=64), nullable=False),
        sa.Column("scope_name", sa.String(length=255), nullable=False),
        sa.Column("event_type_id", sa.Uuid(), nullable=True),
        sa.Column("event_id", sa.Uuid(), nullable=True),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("direction", _enum("anomaly_direction"), nullable=False),
        sa.Column("actual_count", sa.Float(), nullable=False),
        sa.Column("expected_count", sa.Float(), nullable=False),
        sa.Column("drift_field", sa.String(length=255), nullable=True),
        sa.Column("drift_type", _enum("alert_drift_type"), nullable=True),
        sa.Column("sample_value", sa.String(length=500), nullable=True),
        sa.Column("window_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("correlation_group_id", sa.Uuid(), nullable=False),
        sa.Column("observation_count", sa.Integer(), server_default="1", nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["destination_id"], ["alert_destinations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["rule_id"], ["alert_rules.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scan_job_id"], ["scan_jobs.id"], ondelete="SET NULL"),
        # CASCADE, not SET NULL: a buffered alert is pre-delivery state, so an
        # alert about a deleted or merged-away event must never ship.
        sa.ForeignKeyConstraint(["event_type_id"], ["event_types.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "destination_id",
            "rule_id",
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "direction",
            name=_UNIQUE,
        ),
    )
    # Base carries no naming_convention, so index names are spelled explicitly
    # here and in the model's __table_args__ and must stay identical.
    op.create_index(_IX_DESTINATION, _TABLE, ["destination_id"])
    op.create_index(_IX_UPDATED, _TABLE, ["updated_at"])


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    op.drop_index(_IX_UPDATED, table_name=_TABLE)
    op.drop_index(_IX_DESTINATION, table_name=_TABLE)
    op.drop_table(_TABLE)
    op.drop_column("projects", "timezone")
    op.drop_column("alert_destinations", "last_flushed_at")
    op.drop_column("alert_destinations", "delivery_schedule_cron")
