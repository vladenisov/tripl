"""index the three config-scoped hot reads

Revision ID: b3f91a27c045
Revises: e7a1c04b62d8
Create Date: 2026-08-29 09:40:00.000000

Three tables were being read through a predicate no index led with, so each read
degraded into a scan-then-sort that grows with the table. They are batched into
one revision because they are the same mistake in three places and each is a
single ``CREATE INDEX``.

  scan_jobs (scan_config_id, created_at)
      Every reader wants one config's history, newest first, under a LIMIT: the
      beat dispatcher's three lookbacks in ``worker/tasks/metrics/schedule.py``
      and the Scans tab's job list. Only ``scan_config_id`` was indexed, so
      Postgres fetched all of a config's rows and top-N sorted them. This
      supersedes ``ix_scan_job_config`` rather than joining it — the dropped
      index is this one's prefix, so the ON DELETE CASCADE from ``scan_configs``
      is still covered.

  event_metrics (scan_config_id, bucket)
      ``check_metrics_due`` asks each configured scan for its newest bucket on
      every 300s tick. The two unique constraints both interpose
      ``event_id``/``event_type_id`` between the two columns that query reads, so
      neither could serve it and the max() aggregated over every entry for that
      config — six figures of rows for a config with months of hourly buckets.

  alert_delivery_items (correlation_group_id)
      The alerting inbox and every per-incident delivery view filter on the
      correlation group, and ``_alerting_deliveries.list_deliveries`` reaches it
      through a subquery with no other predicate to fall back on. This table has
      no retention sweep, so the scan it was doing grows for the life of the
      deployment.

Ascending in all three although two of the queries read descending: a btree is
scanned equally well in either direction provided every sort column reverses
together.

Not claimed: the ``correlation_group_id IS NULL`` (ungrouped) paths, which this
index does not serve, and retention for either append-only table, which is a
separate product decision.

Pure index work: nothing is rewritten, no column narrowed, no constraint added.
``CREATE INDEX`` locks writes for its duration and is deliberately not
``CONCURRENTLY`` — that form cannot run inside a transaction, and the deploy runs
migrations as a one-shot that must exit 0 before the app serves, so there is
nothing writing to block.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "b3f91a27c045"
down_revision: str | None = "e7a1c04b62d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SCAN_JOB_READ_INDEX = "ix_scan_job_config_created"
_SCAN_JOB_SUPERSEDED = "ix_scan_job_config"
_EVENT_METRIC_INDEX = "ix_event_metric_config_bucket"
_DELIVERY_ITEM_INDEX = "ix_alert_delivery_item_correlation_group"


def upgrade() -> None:
    op.create_index(_SCAN_JOB_READ_INDEX, "scan_jobs", ["scan_config_id", "created_at"])
    # Superseded, not merely redundant: its one column is the composite's prefix.
    op.drop_index(_SCAN_JOB_SUPERSEDED, table_name="scan_jobs")
    op.create_index(_EVENT_METRIC_INDEX, "event_metrics", ["scan_config_id", "bucket"])
    op.create_index(_DELIVERY_ITEM_INDEX, "alert_delivery_items", ["correlation_group_id"])


def downgrade() -> None:
    op.drop_index(_DELIVERY_ITEM_INDEX, table_name="alert_delivery_items")
    op.drop_index(_EVENT_METRIC_INDEX, table_name="event_metrics")
    op.create_index(_SCAN_JOB_SUPERSEDED, "scan_jobs", ["scan_config_id"])
    op.drop_index(_SCAN_JOB_READ_INDEX, table_name="scan_jobs")
