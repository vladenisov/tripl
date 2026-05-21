"""add chart_annotations table

Revision ID: 0a1b2c3d4e6f
Revises: f1a2b3c4d5e6
Create Date: 2026-05-22 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0a1b2c3d4e6f"
down_revision: str | None = "f1a2b3c4d5e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chart_annotations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "project_id",
            sa.Uuid(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # NULL scope_type means project-wide — shows on every chart in the
        # project. When set, the marker only renders on charts matching the
        # scope (project_total | event_type | event) and scope_ref.
        sa.Column("scope_type", sa.String(length=30), nullable=True),
        sa.Column("scope_ref", sa.String(length=120), nullable=True),
        sa.Column("bucket", sa.DateTime(timezone=True), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("color", sa.String(length=20), server_default="#ef4444", nullable=False),
        sa.Column(
            "created_by_user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_chart_annotation_project_bucket",
        "chart_annotations",
        ["project_id", "bucket"],
    )
    op.create_index(
        "ix_chart_annotation_scope",
        "chart_annotations",
        ["project_id", "scope_type", "scope_ref"],
    )


def downgrade() -> None:
    op.drop_index("ix_chart_annotation_scope", table_name="chart_annotations")
    op.drop_index("ix_chart_annotation_project_bucket", table_name="chart_annotations")
    op.drop_table("chart_annotations")
