"""add signal_triage (acknowledge / mute / mark-as-expected on open signals)

A signal that no alert rule routed to an incident was a dead end: the
Anomalies row only navigated, and the one place with triage (the alert inbox)
never saw it (MO-4 / JR-5). This table records the three verdicts a user can
give such a signal:

- ``acknowledged`` — seen; the signal stays listed, marked as acknowledged.
- ``expected`` — a known cause; writes a chart annotation and hides the signal.
- ``muted`` — hides every signal on the scope until ``muted_until``
  (NULL = until unmuted).

The key mirrors ``metric_anomalies``: ``(scan_config_id, scope_type,
scope_ref)`` with a NULL ``scan_config_id`` for project-global ``metric``
scopes, plus the signal's ``bucket`` for the per-signal verdicts. A mute has
no bucket. Because SQL treats NULLs as distinct, the composite UNIQUE only
covers per-signal rows on a scan scope; three partial unique indexes cover
the catalog-metric space and the mute space.

The table starts empty; nothing is back-filled.

Revision ID: d3f7a1c9e254
Revises: c5d1e8a47f20
Create Date: 2026-09-26 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d3f7a1c9e254"
down_revision: str | None = "c5d1e8a47f20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ACTION_ENUM = "signal_triage_action"
_ACTION_VALUES = ("acknowledged", "muted", "expected")


def upgrade() -> None:
    bind = op.get_bind()
    postgresql.ENUM(*_ACTION_VALUES, name=_ACTION_ENUM).create(bind, checkfirst=True)

    op.create_table(
        "signal_triage",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        # NULL for ``metric`` scopes, matching ``metric_anomalies``.
        sa.Column("scan_config_id", sa.Uuid(), nullable=True),
        sa.Column(
            "scope_type",
            # metric_scope_type already exists and is shared with
            # metric_anomalies, alert_delivery_items and others.
            postgresql.ENUM(name="metric_scope_type", create_type=False),
            nullable=False,
        ),
        sa.Column("scope_ref", sa.String(length=64), nullable=False),
        sa.Column(
            "action",
            postgresql.ENUM(*_ACTION_VALUES, name=_ACTION_ENUM, create_type=False),
            nullable=False,
        ),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=True),
        sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("annotation_id", sa.Uuid(), nullable=True),
        sa.Column("created_by_user_id", sa.Uuid(), nullable=True),
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
        sa.CheckConstraint(
            "(action = 'muted') = (bucket IS NULL)",
            name="ck_signal_triage_bucket_matches_action",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["scan_config_id"], ["scan_configs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["annotation_id"], ["chart_annotations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "action",
            "bucket",
            name="uq_signal_triage_signal",
        ),
    )
    op.create_index("ix_signal_triage_project_id", "signal_triage", ["project_id"])
    op.create_index(
        "uq_signal_triage_metric_signal",
        "signal_triage",
        ["project_id", "scope_type", "scope_ref", "action", "bucket"],
        unique=True,
        postgresql_where=sa.text("scan_config_id IS NULL"),
    )
    op.create_index(
        "uq_signal_triage_scope_mute",
        "signal_triage",
        ["project_id", "scan_config_id", "scope_type", "scope_ref"],
        unique=True,
        postgresql_where=sa.text("bucket IS NULL"),
    )
    op.create_index(
        "uq_signal_triage_metric_mute",
        "signal_triage",
        ["project_id", "scope_type", "scope_ref"],
        unique=True,
        postgresql_where=sa.text("bucket IS NULL AND scan_config_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_signal_triage_metric_mute", table_name="signal_triage")
    op.drop_index("uq_signal_triage_scope_mute", table_name="signal_triage")
    op.drop_index("uq_signal_triage_metric_signal", table_name="signal_triage")
    op.drop_index("ix_signal_triage_project_id", table_name="signal_triage")
    # metric_scope_type is shared and stays; only this table's own enum goes.
    op.drop_table("signal_triage")
    postgresql.ENUM(name=_ACTION_ENUM).drop(op.get_bind(), checkfirst=True)
