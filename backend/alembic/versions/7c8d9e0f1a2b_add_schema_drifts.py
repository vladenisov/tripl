"""add schema_drifts

Revision ID: 7c8d9e0f1a2b
Revises: 6b7c8d9e0f1a
Create Date: 2026-05-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "7c8d9e0f1a2b"
down_revision = "6b7c8d9e0f1a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "schema_drifts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "event_type_id",
            sa.Uuid(),
            sa.ForeignKey("event_types.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "scan_config_id",
            sa.Uuid(),
            sa.ForeignKey("scan_configs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("field_name", sa.String(length=255), nullable=False),
        sa.Column("drift_type", sa.String(length=32), nullable=False),
        sa.Column("observed_type", sa.String(length=128), nullable=True),
        sa.Column("declared_type", sa.String(length=64), nullable=True),
        sa.Column("sample_value", sa.Text(), nullable=True),
        sa.Column(
            "detected_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "event_type_id",
            "field_name",
            "drift_type",
            name="uq_schema_drift_event_type_field_kind",
        ),
    )
    op.create_index(
        "ix_schema_drift_event_type_detected",
        "schema_drifts",
        ["event_type_id", "detected_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_schema_drift_event_type_detected", table_name="schema_drifts")
    op.drop_table("schema_drifts")
