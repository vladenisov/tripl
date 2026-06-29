"""add fact_tables catalog table + 'fact' metric kind

Revision ID: a2b3c4d5e6f7
Revises: a1b2c3d4e5f6
Create Date: 2026-06-29 16:00:00.000000

Foundation of the fact-table model (epic tripl-ysji). A ``FactTable`` is a
GLOBAL, project-scoped catalog entity: a full read-only SELECT plus its
introspected columns, timestamp column, identifier columns, and reusable named
row filters. Metrics of the new ``fact`` kind are built on top of it (later
tickets); this migration only creates the table, registers the ``fact`` value
on the ``metric_kind`` enum, and adds the ``metric_definitions.fact_table_id``
FK (SET NULL).
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6f7"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    # ALTER TYPE ... ADD VALUE cannot run inside a transaction block on every
    # supported Postgres version; do it in an autocommit block BEFORE anything
    # else references the new value.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE metric_kind ADD VALUE IF NOT EXISTS 'fact'")

    op.create_table(
        "fact_tables",
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
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("color", sa.String(length=7), nullable=False),
        sa.Column("order", sa.Integer(), server_default="0", nullable=False),
        sa.Column("data_source_id", sa.Uuid(), nullable=True),
        sa.Column("sql", sa.Text(), nullable=False),
        sa.Column("timestamp_column", sa.String(length=255), nullable=False),
        sa.Column("columns", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("identifier_columns", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("row_filters", sa.JSON(), server_default="[]", nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["data_source_id"], ["data_sources.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "name", name="uq_fact_table_project_name"),
    )
    op.create_index("ix_fact_table_project_order", "fact_tables", ["project_id", "order"])

    op.add_column(
        "metric_definitions",
        sa.Column("fact_table_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "fk_metric_def_fact_table",
        "metric_definitions",
        "fact_tables",
        ["fact_table_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    op.drop_constraint("fk_metric_def_fact_table", "metric_definitions", type_="foreignkey")
    op.drop_column("metric_definitions", "fact_table_id")

    op.drop_index("ix_fact_table_project_order", table_name="fact_tables")
    op.drop_table("fact_tables")
    # Postgres has no safe in-place DROP VALUE for an enum; the unused 'fact'
    # label is left on metric_kind (harmless), matching repo precedent for
    # ALTER TYPE ... ADD VALUE.
