"""add catalog metric collection watermark

Revision ID: 1a2b3c4d5e6f
Revises: 0f3a4b5c6d7e
Create Date: 2026-07-14 12:00:00.000000

``last_collection_window_to`` records source-grid progress independently of
persisted values. A successful collection that returns no rows can therefore
remain current instead of being dispatched on every scheduler tick.

SQLite tests build the schema from ``Base.metadata.create_all``; this migration
only runs on PostgreSQL.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "1a2b3c4d5e6f"
down_revision: str | None = "0f3a4b5c6d7e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.add_column(
        "metric_definitions",
        sa.Column("last_collection_window_to", sa.DateTime(timezone=True), nullable=True),
    )
    # PostgreSQL UNIQUE constraints consider NULLs distinct. Catalog fact/sql
    # rows intentionally have no scan_config_id, so the original constraints
    # did not prevent concurrent/redelivered collectors from inserting the same
    # logical bucket twice. Keep the newest legacy duplicate before adding the
    # NULL-specialized indexes.
    op.execute(
        sa.text(
            """
            DELETE FROM metric_values
            WHERE id IN (
                SELECT id
                FROM (
                    SELECT
                        id,
                        ROW_NUMBER() OVER (
                            PARTITION BY metric_definition_id, bucket
                            ORDER BY created_at DESC, id DESC
                        ) AS duplicate_rank
                    FROM metric_values
                    WHERE scan_config_id IS NULL
                ) AS ranked
                WHERE duplicate_rank > 1
            )
            """
        )
    )
    op.execute(
        sa.text(
            """
            DELETE FROM metric_value_breakdowns
            WHERE id IN (
                SELECT id
                FROM (
                    SELECT
                        id,
                        ROW_NUMBER() OVER (
                            PARTITION BY
                                metric_definition_id,
                                bucket,
                                breakdown_column,
                                breakdown_value,
                                is_other
                            ORDER BY created_at DESC, id DESC
                        ) AS duplicate_rank
                    FROM metric_value_breakdowns
                    WHERE scan_config_id IS NULL
                ) AS ranked
                WHERE duplicate_rank > 1
            )
            """
        )
    )
    op.create_index(
        "uq_metric_value_catalog_bucket",
        "metric_values",
        ["metric_definition_id", "bucket"],
        unique=True,
        postgresql_where=sa.text("scan_config_id IS NULL"),
    )
    op.create_index(
        "uq_metric_value_breakdown_catalog_bucket_value",
        "metric_value_breakdowns",
        [
            "metric_definition_id",
            "bucket",
            "breakdown_column",
            "breakdown_value",
            "is_other",
        ],
        unique=True,
        postgresql_where=sa.text("scan_config_id IS NULL"),
    )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.drop_index(
        "uq_metric_value_breakdown_catalog_bucket_value",
        table_name="metric_value_breakdowns",
    )
    op.drop_index("uq_metric_value_catalog_bucket", table_name="metric_values")
    op.drop_column("metric_definitions", "last_collection_window_to")
