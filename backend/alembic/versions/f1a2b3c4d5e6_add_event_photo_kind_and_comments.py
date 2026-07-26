"""add event_photo kind/external_url and event_photo_comments

Revision ID: f1a2b3c4d5e6
Revises: e7f8a9b0c1d2
Create Date: 2026-05-21 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: str | None = "e7f8a9b0c1d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "event_photos",
        sa.Column(
            "kind",
            sa.String(length=20),
            server_default="photo",
            nullable=False,
        ),
    )
    op.add_column(
        "event_photos",
        sa.Column("external_url", sa.String(length=2000), nullable=True),
    )
    # Figma-kind rows don't upload bytes, so storage_* columns become optional.
    op.alter_column(
        "event_photos", "storage_backend", existing_type=sa.String(length=20), nullable=True
    )
    op.alter_column(
        "event_photos", "storage_key", existing_type=sa.String(length=500), nullable=True
    )

    op.create_table(
        "event_photo_comments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "photo_id",
            sa.Uuid(),
            sa.ForeignKey("event_photos.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_id",
            sa.Uuid(),
            sa.ForeignKey("event_photo_comments.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("body", sa.Text(), nullable=False),
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
        "ix_event_photo_comment_photo_created",
        "event_photo_comments",
        ["photo_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_event_photo_comment_photo_created", table_name="event_photo_comments")
    op.drop_table("event_photo_comments")
    op.alter_column(
        "event_photos", "storage_key", existing_type=sa.String(length=500), nullable=False
    )
    op.alter_column(
        "event_photos", "storage_backend", existing_type=sa.String(length=20), nullable=False
    )
    op.drop_column("event_photos", "external_url")
    op.drop_column("event_photos", "kind")
