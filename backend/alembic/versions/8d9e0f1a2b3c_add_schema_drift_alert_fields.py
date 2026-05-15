"""add schema drift alert fields

Revision ID: 8d9e0f1a2b3c
Revises: 7c8d9e0f1a2b
Create Date: 2026-05-15
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "8d9e0f1a2b3c"
down_revision = "7c8d9e0f1a2b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "alert_rules",
        sa.Column("include_schema_drifts", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "alert_delivery_items",
        sa.Column("drift_field", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "alert_delivery_items",
        sa.Column("drift_type", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "alert_delivery_items",
        sa.Column("sample_value", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("alert_delivery_items", "sample_value")
    op.drop_column("alert_delivery_items", "drift_type")
    op.drop_column("alert_delivery_items", "drift_field")
    op.drop_column("alert_rules", "include_schema_drifts")
