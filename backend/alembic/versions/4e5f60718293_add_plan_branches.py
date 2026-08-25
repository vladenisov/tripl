"""add plan_branches + branch_id on plan tables

Revision ID: 4e5f60718293
Revises: 3d4e5f607182
Create Date: 2026-05-27 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4e5f60718293"
down_revision: str | None = "3d4e5f607182"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Top-level design-time tables that become branch-scoped. Children
# (field_definitions, event_field_values, event_meta_values, event_tags)
# inherit their branch from the parent and carry no branch_id.
_BRANCHED_TABLES = (
    "event_types",
    "events",
    "variables",
    "meta_field_definitions",
    "event_type_relations",
)

# (table, constraint_name, new_columns) — unique constraints that must include
# branch_id so they are enforced per-branch (main included).
_UNIQUE_SWAPS = (
    ("event_types", "uq_event_type_project_name", ["project_id", "branch_id", "name"]),
    ("variables", "uq_variable_project_name", ["project_id", "branch_id", "name"]),
    (
        "variables",
        "uq_variable_project_source_name",
        ["project_id", "branch_id", "source_name"],
    ),
    (
        "meta_field_definitions",
        "uq_meta_field_def_project_name",
        ["project_id", "branch_id", "name"],
    ),
)

_OLD_UNIQUE = {
    "uq_event_type_project_name": ("event_types", ["project_id", "name"]),
    "uq_variable_project_name": ("variables", ["project_id", "name"]),
    "uq_variable_project_source_name": ("variables", ["project_id", "source_name"]),
    "uq_meta_field_def_project_name": ("meta_field_definitions", ["project_id", "name"]),
}


def upgrade() -> None:
    op.create_table(
        "plan_branches",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False, server_default="working"),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="draft"),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "base_revision_id",
            sa.Uuid(),
            sa.ForeignKey("plan_revisions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("merged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "merged_by",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("project_id", "name", name="uq_plan_branch_project_name"),
    )
    op.create_index("ix_plan_branch_project", "plan_branches", ["project_id"])

    # One main branch per existing project (the live plan).
    op.execute(
        """
        INSERT INTO plan_branches
            (id, project_id, name, kind, status, description, created_at, updated_at)
        SELECT gen_random_uuid(), p.id, 'main', 'main', 'merged', '', now(), now()
        FROM projects p
        """
    )

    # Add branch_id (nullable), backfill to the project's main branch, then lock down.
    for table in _BRANCHED_TABLES:
        op.add_column(table, sa.Column("branch_id", sa.Uuid(), nullable=True))
        op.execute(
            f"""
            UPDATE {table} AS t
            SET branch_id = b.id
            FROM plan_branches AS b
            WHERE b.project_id = t.project_id AND b.kind = 'main'
            """  # noqa: S608 — table names are a fixed internal allowlist
        )
        op.alter_column(table, "branch_id", nullable=False)
        op.create_foreign_key(
            f"fk_{table}_branch_id",
            table,
            "plan_branches",
            ["branch_id"],
            ["id"],
            ondelete="CASCADE",
        )
        op.create_index(f"ix_{table}_branch_id", table, ["branch_id"])

    # Swap unique constraints to be per-branch.
    for table, name, columns in _UNIQUE_SWAPS:
        op.drop_constraint(name, table, type_="unique")
        op.create_unique_constraint(name, table, columns)


def downgrade() -> None:
    # Non-main branches hold deep copies of the main plan under the same names,
    # so the project-scoped unique constraints below cannot be restored while
    # they exist. Runs first, and while plan_branches is still around to name
    # them; deleting an event_type cascades to its events and relations.
    for table in _BRANCHED_TABLES:
        op.execute(
            f"""
            DELETE FROM {table}
            WHERE branch_id IN (SELECT id FROM plan_branches WHERE kind <> 'main')
            """  # noqa: S608 — table names are a fixed internal allowlist
        )

    for name, (table, columns) in _OLD_UNIQUE.items():
        op.drop_constraint(name, table, type_="unique")
        op.create_unique_constraint(name, table, columns)

    for table in _BRANCHED_TABLES:
        op.drop_index(f"ix_{table}_branch_id", table_name=table)
        op.drop_constraint(f"fk_{table}_branch_id", table, type_="foreignkey")
        op.drop_column(table, "branch_id")

    op.drop_index("ix_plan_branch_project", table_name="plan_branches")
    op.drop_table("plan_branches")
