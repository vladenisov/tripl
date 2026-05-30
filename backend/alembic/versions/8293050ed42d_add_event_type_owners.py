"""add event_type_owners table

Revision ID: 8293050ed42d
Revises: 7182930506b2
Create Date: 2026-05-30 14:30:00.000000

Adds the event_type_owners table backing per-event-type stakeholder ownership.
Owners gate plan-branch merges: a branch touching an owned event type requires
an approval from at least one of its owners. Owners attach to the live main
event_type only — they are not branched.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "8293050ed42d"
down_revision = "7182930506b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_type_owners",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_type_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("granted_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["event_type_id"], ["event_types.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["granted_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_type_id", "user_id", name="uq_event_type_owner"),
    )
    op.create_index(
        "ix_event_type_owners_event_type_id",
        "event_type_owners",
        ["event_type_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_event_type_owners_event_type_id", table_name="event_type_owners")
    op.drop_table("event_type_owners")
