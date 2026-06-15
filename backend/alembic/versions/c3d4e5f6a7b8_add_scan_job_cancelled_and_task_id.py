"""add scan job cancelled status and celery_task_id

Revision ID: c3d4e5f6a7b8
Revises: a6b7c8d9e0f1
Create Date: 2026-06-15 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3d4e5f6a7b8"
down_revision: str | None = "a6b7c8d9e0f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "scan_jobs",
        sa.Column("celery_task_id", sa.Text(), nullable=True),
    )
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        # ALTER TYPE ... ADD VALUE cannot run inside a transaction block on
        # every supported Postgres version; do it in an autocommit block.
        with op.get_context().autocommit_block():
            op.execute("ALTER TYPE scan_job_status ADD VALUE IF NOT EXISTS 'cancelled'")


def downgrade() -> None:
    op.drop_column("scan_jobs", "celery_task_id")
    # Postgres has no safe in-place DROP VALUE for an enum; the unused
    # 'cancelled' label is left in scan_job_status (harmless).
