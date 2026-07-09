"""add variable documented values and bindings

Revision ID: f0e1d2c3b4a5
Revises: d9e0f1a2b3c4
Create Date: 2026-07-09 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f0e1d2c3b4a5"
down_revision: str | None = "d9e0f1a2b3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "variables",
        sa.Column("allowed_values", sa.JSON(), server_default="[]", nullable=False),
    )
    op.add_column(
        "variables",
        sa.Column("bindings", sa.JSON(), server_default="[]", nullable=False),
    )

    # Backfill bindings from the scan-detected source_name so existing
    # scan-created variables keep matching observations under the new
    # binding-based adoption. Row counts are small; per-row updates keep the
    # JSON serialization portable across dialects.
    conn = op.get_bind()
    variables = sa.table(
        "variables",
        sa.column("id", sa.Uuid()),
        sa.column("source_name", sa.String()),
        sa.column("bindings", sa.JSON()),
    )
    rows = conn.execute(
        sa.select(variables.c.id, variables.c.source_name).where(
            variables.c.source_name.is_not(None)
        )
    ).fetchall()
    for row in rows:
        conn.execute(
            sa.update(variables).where(variables.c.id == row.id).values(bindings=[row.source_name])
        )

    op.create_table(
        "variable_event_value_overrides",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("branch_id", sa.Uuid(), nullable=False),
        sa.Column("variable_id", sa.Uuid(), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("values", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["branch_id"], ["plan_branches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["variable_id"], ["variables.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("variable_id", "event_id", name="uq_variable_event_value_override"),
    )
    op.create_index(
        "ix_variable_event_value_overrides_branch_id",
        "variable_event_value_overrides",
        ["branch_id"],
    )
    op.create_index(
        "ix_variable_event_value_overrides_variable_id",
        "variable_event_value_overrides",
        ["variable_id"],
    )
    op.create_index(
        "ix_variable_event_value_overrides_event_id",
        "variable_event_value_overrides",
        ["event_id"],
    )
    op.create_index(
        "ix_variable_event_value_overrides_project_branch",
        "variable_event_value_overrides",
        ["project_id", "branch_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_variable_event_value_overrides_project_branch",
        table_name="variable_event_value_overrides",
    )
    op.drop_index(
        "ix_variable_event_value_overrides_event_id",
        table_name="variable_event_value_overrides",
    )
    op.drop_index(
        "ix_variable_event_value_overrides_variable_id",
        table_name="variable_event_value_overrides",
    )
    op.drop_index(
        "ix_variable_event_value_overrides_branch_id",
        table_name="variable_event_value_overrides",
    )
    op.drop_table("variable_event_value_overrides")
    op.drop_column("variables", "bindings")
    op.drop_column("variables", "allowed_values")
