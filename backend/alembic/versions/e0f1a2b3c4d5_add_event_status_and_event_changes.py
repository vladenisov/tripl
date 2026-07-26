"""add event status and event_changes

Revision ID: e0f1a2b3c4d5
Revises: d0e1f2a3b4c5
Create Date: 2026-06-11 00:00:00.000000

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "e0f1a2b3c4d5"
down_revision = "d0e1f2a3b4c5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add status column (nullable first, then backfill, then set NOT NULL)
    with op.batch_alter_table("events") as batch_op:
        batch_op.add_column(sa.Column("status", sa.String(20), nullable=True))

    # 2. Backfill status from the three boolean columns
    #    Priority order (highest wins):
    #      archived=true               → 'archived'
    #      implemented=True AND last_seen_at IS NOT NULL → 'live'
    #      implemented=True            → 'implemented'
    #      reviewed=False              → 'in_review'
    #      else                        → 'ready_for_dev'
    op.execute(
        """
        UPDATE events
        SET status = CASE
            WHEN archived THEN 'archived'
            WHEN implemented AND last_seen_at IS NOT NULL THEN 'live'
            WHEN implemented THEN 'implemented'
            WHEN NOT reviewed THEN 'in_review'
            ELSE 'ready_for_dev'
        END
        WHERE status IS NULL
        """
    )

    # 3. Make status NOT NULL with server default 'draft'
    with op.batch_alter_table("events") as batch_op:
        batch_op.alter_column(
            "status",
            existing_type=sa.String(20),
            nullable=False,
            server_default="draft",
        )

    # 4. Add sunset_at column
    with op.batch_alter_table("events") as batch_op:
        batch_op.add_column(sa.Column("sunset_at", sa.DateTime(timezone=True), nullable=True))

    # 5. Drop the old boolean columns
    with op.batch_alter_table("events") as batch_op:
        batch_op.drop_column("archived")
        batch_op.drop_column("reviewed")
        batch_op.drop_column("implemented")

    # 6. Add composite index on (project_id, branch_id, status)
    op.create_index(
        "ix_events_project_branch_status",
        "events",
        ["project_id", "branch_id", "status"],
    )

    # 7. Create event_changes table
    op.create_table(
        "event_changes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("field", sa.String(100), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_event_changes_event_id", "event_changes", ["event_id"])


def downgrade() -> None:
    # Drop event_changes table
    op.drop_index("ix_event_changes_event_id", table_name="event_changes")
    op.drop_table("event_changes")

    # Drop the composite index
    op.drop_index("ix_events_project_branch_status", table_name="events")

    # Restore boolean columns
    with op.batch_alter_table("events") as batch_op:
        batch_op.add_column(sa.Column("implemented", sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column("reviewed", sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column("archived", sa.Boolean(), nullable=True))

    # Backfill booleans from status
    op.execute(
        """
        UPDATE events
        SET
            archived    = (status = 'archived'),
            implemented = (status IN ('implemented', 'live', 'deprecated', 'archived')),
            reviewed    = (status IN ('ready_for_dev', 'implemented', 'live', 'deprecated', 'archived'))
        """
    )

    # Make booleans NOT NULL
    with op.batch_alter_table("events") as batch_op:
        batch_op.alter_column(
            "implemented", existing_type=sa.Boolean(), nullable=False, server_default="false"
        )
        batch_op.alter_column(
            "reviewed", existing_type=sa.Boolean(), nullable=False, server_default="true"
        )
        batch_op.alter_column(
            "archived", existing_type=sa.Boolean(), nullable=False, server_default="false"
        )

    # Drop sunset_at and status
    with op.batch_alter_table("events") as batch_op:
        batch_op.drop_column("sunset_at")
        batch_op.drop_column("status")
