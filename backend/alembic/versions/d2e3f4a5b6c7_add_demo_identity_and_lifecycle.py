"""add demo identity, provisioning lifecycle, and data-source ownership

Revision ID: d2e3f4a5b6c7
Revises: a0b1c2d3e4f6
Create Date: 2026-07-11 17:00:00.000000

Epic tripl-2su6.1 — make the demo a first-class, generated project with explicit
identity and an observable provisioning lifecycle, and give data sources an
optional owning project so a demo's synthetic warehouse is cleaned up with the
project instead of leaking a workspace-global orphan.

SQLite (tests) builds the schema from ``Base.metadata.create_all``; this
migration only runs on PostgreSQL.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d2e3f4a5b6c7"
down_revision: str | None = "a0b1c2d3e4f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_GENERATION_STATUS = ("pending", "seeding", "ready", "failed")


def _generation_status_enum() -> postgresql.ENUM:
    return postgresql.ENUM(*_GENERATION_STATUS, name="project_generation_status", create_type=False)


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    bind = op.get_bind()
    postgresql.ENUM(*_GENERATION_STATUS, name="project_generation_status").create(
        bind, checkfirst=True
    )

    # projects: demo identity + provisioning lifecycle
    op.add_column(
        "projects",
        sa.Column("is_demo", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column("projects", sa.Column("demo_recipe_version", sa.String(length=32), nullable=True))
    op.add_column(
        "projects",
        sa.Column(
            "generation_status",
            _generation_status_enum(),
            server_default="ready",
            nullable=False,
        ),
    )
    op.add_column("projects", sa.Column("generation_stage", sa.String(length=64), nullable=True))
    op.add_column("projects", sa.Column("generation_error", sa.Text(), nullable=True))
    op.add_column("projects", sa.Column("created_by_user_id", sa.Uuid(), nullable=True))
    op.add_column(
        "projects", sa.Column("demo_seeded_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_foreign_key(
        "fk_projects_created_by_user_id",
        "projects",
        "users",
        ["created_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # data_sources: optional owning project (demo synthetic warehouse)
    op.add_column("data_sources", sa.Column("project_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_data_sources_project_id",
        "data_sources",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_data_sources_project_id", "data_sources", ["project_id"])


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    op.drop_index("ix_data_sources_project_id", table_name="data_sources")
    op.drop_constraint("fk_data_sources_project_id", "data_sources", type_="foreignkey")
    op.drop_column("data_sources", "project_id")

    op.drop_constraint("fk_projects_created_by_user_id", "projects", type_="foreignkey")
    op.drop_column("projects", "demo_seeded_at")
    op.drop_column("projects", "created_by_user_id")
    op.drop_column("projects", "generation_error")
    op.drop_column("projects", "generation_stage")
    op.drop_column("projects", "generation_status")
    op.drop_column("projects", "demo_recipe_version")
    op.drop_column("projects", "is_demo")

    _generation_status_enum().drop(op.get_bind(), checkfirst=True)
