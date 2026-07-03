"""add plan_hash to plan_branch_approvals (approval freshness)

Revision ID: f8a9b0c1d2e3
Revises: c5d6e7f8a9b0
Create Date: 2026-07-02 18:00:00.000000

Approvals now record a content hash of the branch plan they approved
(tripl-d8v6): the merge gates only count approvals whose hash matches the
branch's current content, so post-approval edits invalidate the review
instead of merging unreviewed changes. Legacy rows keep NULL and read as
stale — a re-approve restamps them.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f8a9b0c1d2e3"
down_revision: str | None = "c5d6e7f8a9b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "plan_branch_approvals",
        sa.Column("plan_hash", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("plan_branch_approvals", "plan_hash")
