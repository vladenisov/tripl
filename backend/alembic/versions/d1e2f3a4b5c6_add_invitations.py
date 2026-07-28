"""add invitations so an owner can onboard without opening registration

Purely additive: a new ``invitations`` table, no change to existing ones. Until
this shipped, self-service registration was the ONLY way to add a person, which
forced ``registration_mode`` to ``open`` on any instance that still needed to
onboard someone (tripl-jfm3.80 / .82).

``role`` reuses the EXISTING ``user_role`` PostgreSQL enum created by
f5a6b7c8d9e0, hence ``create_type=False`` — letting Alembic emit its own CREATE
TYPE here would fail on any database that has already run that migration.

``invited_by_user_id`` is ON DELETE SET NULL, not CASCADE: an owner leaving must
not silently void invitations they had already sent, and the row stays useful as
a record of how an account came to exist.

Revision ID: d1e2f3a4b5c6
Revises: b2c3d4e5f6a7
Create Date: 2026-07-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d1e2f3a4b5c6"
down_revision: str | None = "b2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "invitations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column(
            "role",
            postgresql.ENUM("owner", "editor", "viewer", name="user_role", create_type=False),
            nullable=False,
            server_default="editor",
        ),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "invited_by_user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_invitations_email", "invitations", ["email"])
    op.create_index("ix_invitations_token_hash", "invitations", ["token_hash"], unique=True)
    op.create_index("ix_invitations_expires_at", "invitations", ["expires_at"])
    op.create_index("ix_invitations_invited_by_user_id", "invitations", ["invited_by_user_id"])


def downgrade() -> None:
    op.drop_index("ix_invitations_invited_by_user_id", table_name="invitations")
    op.drop_index("ix_invitations_expires_at", table_name="invitations")
    op.drop_index("ix_invitations_token_hash", table_name="invitations")
    op.drop_index("ix_invitations_email", table_name="invitations")
    op.drop_table("invitations")
