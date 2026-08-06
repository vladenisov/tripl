"""add anomaly_scope_overrides (per-scope false-positive ratchet)

The "false positive" button in the alert inbox used to raise
``sigma_threshold`` by 0.5 and ``min_expected_count`` by 5 on
``project_anomaly_settings`` AND on every ``scan_configs`` row the dismissed
group touched. One click therefore desensitised every other event, event type,
project total and catalog metric in the project, permanently and with no record
of which click caused which increment. This table moves the ratchet onto the
scope that was actually dismissed.

The key mirrors ``metric_anomalies``: ``(scan_config_id, scope_type,
scope_ref)``, with a NULL ``scan_config_id`` for project-global ``metric``
scopes. That is the only key the detection loops can honour.

MIGRATING EXISTING TUNING: the table starts EMPTY and the already-applied
project-wide values on ``project_anomaly_settings`` / ``scan_configs`` are left
exactly as they are. They simply become the baseline that per-scope overrides
sit on top of. Nothing is lost — every instance keeps the sensitivity it is
running today — and nothing is double-counted, because no override row is
synthesised from a value that has already been applied in place. There is no
record of how much of a given 4.0/50 came from ratcheting versus an operator
deliberately setting it (production sits at the operator-set 4.0/50 with
``false_positive_count`` 0 everywhere), so back-computing rows would be a guess
that silently re-tightened or loosened live detection.

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-08-06 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c8d9e0f1a2b3"
down_revision: str | None = "b7c8d9e0f1a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "anomaly_scope_overrides",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        # NULL for ``metric`` scopes (project-global catalog series), matching
        # the NULL ``metric_anomalies.scan_config_id`` those rows carry.
        sa.Column("scan_config_id", sa.Uuid(), nullable=True),
        sa.Column(
            "scope_type",
            # create_type=False: metric_scope_type already exists and is shared
            # with metric_anomalies, alert_delivery_items and others.
            postgresql.ENUM(name="metric_scope_type", create_type=False),
            nullable=False,
        ),
        sa.Column("scope_ref", sa.String(length=64), nullable=False),
        sa.Column("scope_name", sa.String(length=255), server_default="", nullable=False),
        sa.Column("sigma_threshold", sa.Float(), nullable=False),
        sa.Column("min_expected_count", sa.Integer(), nullable=False),
        sa.Column("false_positive_count", sa.Integer(), server_default="0", nullable=False),
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
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "scan_config_id",
            "scope_type",
            "scope_ref",
            name="uq_anomaly_scope_override_scope",
        ),
    )
    # SQL treats NULLs as DISTINCT, so the composite UNIQUE above never fires
    # for ``metric`` scopes (NULL scan_config_id) and a second click on the same
    # metric would insert a duplicate row instead of ratcheting the first. This
    # partial unique index excludes the NULL column and covers only the NULL
    # space, exactly as ``uq_metric_anomaly_metric_scope`` does for anomalies.
    op.create_index(
        "uq_anomaly_scope_override_metric_scope",
        "anomaly_scope_overrides",
        ["project_id", "scope_type", "scope_ref"],
        unique=True,
        postgresql_where=sa.text("scan_config_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_anomaly_scope_override_metric_scope",
        table_name="anomaly_scope_overrides",
    )
    # The metric_scope_type enum is SHARED (metric_anomalies,
    # alert_delivery_items, release_comparabilities, ...) — dropping it here
    # would take those columns with it. Only the table goes.
    op.drop_table("anomaly_scope_overrides")
