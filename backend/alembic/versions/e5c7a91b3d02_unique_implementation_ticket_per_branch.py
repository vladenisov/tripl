"""one implementation ticket per branch

Revision ID: e5c7a91b3d02
Revises: b2d3f4a5c6e7
Create Date: 2026-08-23 09:00:00.000000

The create task's "does a ticket already exist for this branch?" check was the
only thing keeping merges from opening duplicate Jira issues, and nothing in the
schema backed it. The task now commits its row before it calls the tracker, so
this constraint is what makes a concurrent second claim lose instead of opening
a second issue (tripl-l33u.11).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "e5c7a91b3d02"
down_revision: str | None = "b2d3f4a5c6e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CONSTRAINT_NAME = "uq_implementation_ticket_branch"


def upgrade() -> None:
    # Delete-then-narrow: a populated database can already hold the duplicates
    # this constraint forbids. Keep the NEWEST row per branch — it is the one the
    # UI has been linking to, and on a duplicate pair the later Jira issue is the
    # one a human most likely acted on.
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY branch_id
                    ORDER BY created_at DESC, id DESC
                ) AS rn
            FROM implementation_tickets
        )
        DELETE FROM implementation_tickets t
        USING ranked r
        WHERE t.id = r.id
          AND r.rn > 1
        """
    )
    op.create_unique_constraint(
        _CONSTRAINT_NAME,
        "implementation_tickets",
        ["branch_id"],
    )


def downgrade() -> None:
    op.drop_constraint(_CONSTRAINT_NAME, "implementation_tickets", type_="unique")
