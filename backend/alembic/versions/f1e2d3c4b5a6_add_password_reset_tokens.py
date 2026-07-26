"""add password_reset_tokens table

Revision ID: f1e2d3c4b5a6
Revises: d4e5f6a7b8c9
Create Date: 2026-07-23 09:00:00.000000

Backs the self-service password reset flow (POST /auth/password-reset/request
and /confirm). The raw reset token is never stored — only its keyed
HMAC-SHA256 digest (``token_hash``), matching ``user_sessions``. ``expires_at``
gives each link a short TTL and ``used_at`` enforces single use.

``created_at`` / ``updated_at`` carry ``server_default=now()`` from the start so
a migration-built database agrees with the model's ``TimestampMixin`` (avoids the
drift the earlier ``d4e5f6a7b8c9`` migration had to repair).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "f1e2d3c4b5a6"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
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
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_password_reset_tokens_user_id", "password_reset_tokens", ["user_id"])
    # Unique index (not a bare constraint) mirrors the model's
    # ``token_hash = mapped_column(..., unique=True, index=True)``.
    op.create_index(
        "ix_password_reset_tokens_token_hash",
        "password_reset_tokens",
        ["token_hash"],
        unique=True,
    )
    op.create_index("ix_password_reset_tokens_expires_at", "password_reset_tokens", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_password_reset_tokens_expires_at", table_name="password_reset_tokens")
    op.drop_index("ix_password_reset_tokens_token_hash", table_name="password_reset_tokens")
    op.drop_index("ix_password_reset_tokens_user_id", table_name="password_reset_tokens")
    op.drop_table("password_reset_tokens")
