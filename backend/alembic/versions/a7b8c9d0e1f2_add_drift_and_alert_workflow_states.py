"""add drift and alert workflow states

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-06-10 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: str | None = "f6a7b8c9d0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "schema_drifts",
        sa.Column("status", sa.String(length=32), server_default="open", nullable=False),
    )
    op.add_column("schema_drifts", sa.Column("resolution_note", sa.Text(), nullable=True))
    op.add_column(
        "schema_drifts",
        sa.Column("snoozed_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "schema_drifts",
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("schema_drifts", sa.Column("resolved_by", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_schema_drifts_resolved_by",
        "schema_drifts",
        "users",
        ["resolved_by"],
        ["id"],
        ondelete="SET NULL",
    )

    op.create_table(
        "alert_correlation_states",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("correlation_group_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="open", nullable=False),
        sa.Column("muted_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("false_positive_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acted_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["acted_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "correlation_group_id",
            name="uq_alert_correlation_state_project_group",
        ),
    )
    op.create_index(
        "ix_alert_correlation_state_project_status",
        "alert_correlation_states",
        ["project_id", "status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_alert_correlation_state_project_status",
        table_name="alert_correlation_states",
    )
    op.drop_table("alert_correlation_states")
    op.drop_constraint("fk_schema_drifts_resolved_by", "schema_drifts", type_="foreignkey")
    op.drop_column("schema_drifts", "resolved_by")
    op.drop_column("schema_drifts", "resolved_at")
    op.drop_column("schema_drifts", "snoozed_until")
    op.drop_column("schema_drifts", "resolution_note")
    op.drop_column("schema_drifts", "status")
