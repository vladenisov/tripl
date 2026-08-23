"""add metric anomaly scope (scope_type 'metric', nullable scan_config_id)

Revision ID: a1b2c3d4e5f6
Revises: e9f0a1b2c3d4
Create Date: 2026-06-29 15:00:00.000000

Metric anomaly scope for catalog metric series (epic tripl-dxhp, ticket .6):

* ``metric_scope_type`` gains a ``'metric'`` value (catalog MetricDefinition
  series). Added in an autocommit block because Postgres cannot ``ALTER TYPE
  ... ADD VALUE`` inside a transaction on every supported version.
* ``metric_anomalies.scan_config_id`` becomes NULLABLE — ``metric``-scope rows
  are project-global and not tied to a single scan config.
* a ``(scope_ref, bucket)`` index speeds the metric-keyed read/recompute path.
* a PARTIAL UNIQUE index ``uq_metric_anomaly_metric_scope`` on
  ``(scope_type, scope_ref, bucket) WHERE scan_config_id IS NULL`` enforces
  idempotency for ``metric``-scope rows. The composite ``uq_metric_anomaly_
  scope_bucket`` constraint cannot: Postgres/SQLite treat NULLs as DISTINCT, so
  two ``(NULL, 'metric', ref, bucket)`` rows never conflict. The partial index
  excludes ``scan_config_id`` so its NULLs cannot defeat the dedupe, giving the
  recompute upsert a real conflict target for concurrent runs.
* ``project_anomaly_settings.detect_metrics`` (default ON) gates detection.
* ``alert_rules.include_metrics`` (default OFF) gates delivery.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "e9f0a1b2c3d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    # ALTER TYPE ... ADD VALUE cannot run inside a transaction block on every
    # supported Postgres version; do it in an autocommit block BEFORE anything
    # else references the new value.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE metric_scope_type ADD VALUE IF NOT EXISTS 'metric'")

    op.alter_column(
        "metric_anomalies",
        "scan_config_id",
        existing_type=sa.Uuid(),
        nullable=True,
    )
    op.create_index(
        "ix_metric_anomaly_scope_ref_bucket",
        "metric_anomalies",
        ["scope_ref", "bucket"],
    )
    # Idempotency for project-global ``metric``-scope rows: the composite UNIQUE
    # constraint includes scan_config_id, whose NULLs are DISTINCT, so it cannot
    # block duplicate (NULL, 'metric', ref, bucket) rows from concurrent runs.
    # This partial unique index excludes scan_config_id and only covers the NULL
    # space, giving the recompute upsert a real conflict target.
    op.create_index(
        "uq_metric_anomaly_metric_scope",
        "metric_anomalies",
        ["scope_type", "scope_ref", "bucket"],
        unique=True,
        postgresql_where=sa.text("scan_config_id IS NULL"),
    )
    op.add_column(
        "project_anomaly_settings",
        sa.Column(
            "detect_metrics",
            sa.Boolean(),
            server_default="true",
            nullable=False,
        ),
    )
    op.add_column(
        "alert_rules",
        sa.Column(
            "include_metrics",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    op.drop_column("alert_rules", "include_metrics")
    op.drop_column("project_anomaly_settings", "detect_metrics")
    op.drop_index("uq_metric_anomaly_metric_scope", table_name="metric_anomalies")
    op.drop_index("ix_metric_anomaly_scope_ref_bucket", table_name="metric_anomalies")
    # ``metric``-scope rows are project-global and carry no scan_config_id, so
    # there is nothing to backfill for them under the restored NOT NULL.
    op.execute("DELETE FROM metric_anomalies WHERE scan_config_id IS NULL")
    op.alter_column(
        "metric_anomalies",
        "scan_config_id",
        existing_type=sa.Uuid(),
        nullable=False,
    )
    # Postgres has no safe in-place DROP VALUE for an enum; the unused 'metric'
    # label is left in metric_scope_type (harmless).
