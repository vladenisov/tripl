"""add project scope to api_keys

Revision ID: b5c6d7e8f9a0
Revises: a4b5c6d7e8f9
Create Date: 2026-06-01 12:00:00.000000

Adds a nullable ``project_id`` FK so a key can be fenced to a single project.
NULL keeps the legacy cross-project behaviour, so existing keys are unaffected.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b5c6d7e8f9a0"
down_revision = "a4b5c6d7e8f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("api_keys", sa.Column("project_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_api_keys_project_id",
        "api_keys",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_api_keys_project_id", "api_keys", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_api_keys_project_id", table_name="api_keys")
    op.drop_constraint("fk_api_keys_project_id", "api_keys", type_="foreignkey")
    op.drop_column("api_keys", "project_id")
