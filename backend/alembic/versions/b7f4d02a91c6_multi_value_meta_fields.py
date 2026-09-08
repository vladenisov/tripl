"""an event can carry several values for one meta field

Revision ID: b7f4d02a91c6
Revises: a2e5c19f7b34
Create Date: 2026-09-08 22:40:00.000000

"One Jira key per event" was never a decision anyone made about tickets. A key
is an ``event_meta_values`` row, and ``uq_event_meta_value_event_meta`` allowed
exactly one per field per event — so an event picked up again in a second task
had nowhere to put the second key (tripl-h2sx.31).

``allow_multiple`` on the definition opts a field in, and the row constraint
moves from ``(event_id, meta_field_definition_id)`` to
``(event_id, meta_field_definition_id, value)``. The old constraint was
strictly stronger, so every existing row already satisfies the new one and
nothing is rewritten. Whether a given field may hold more than one value is
enforced in the service, where the definition is in hand; the constraint keeps
doing what it was really there for, which is stopping the same value being
stored twice.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7f4d02a91c6"
down_revision: str | None = "a2e5c19f7b34"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "meta_field_definitions",
        sa.Column("allow_multiple", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.drop_constraint("uq_event_meta_value_event_meta", "event_meta_values", type_="unique")
    op.create_unique_constraint(
        "uq_event_meta_value_event_meta_value",
        "event_meta_values",
        ["event_id", "meta_field_definition_id", "value"],
    )


def downgrade() -> None:
    # The old constraint is stronger, so anything a multi-valued field collected
    # has to go before it can be restored. Keep one row per (event, field) —
    # the lowest id, which is stable rather than arbitrary.
    op.execute(
        sa.text(
            """
            DELETE FROM event_meta_values
            WHERE id NOT IN (
                SELECT MIN(id)
                FROM event_meta_values
                GROUP BY event_id, meta_field_definition_id
            )
            """
        )
    )
    op.drop_constraint("uq_event_meta_value_event_meta_value", "event_meta_values", type_="unique")
    op.create_unique_constraint(
        "uq_event_meta_value_event_meta",
        "event_meta_values",
        ["event_id", "meta_field_definition_id"],
    )
    op.drop_column("meta_field_definitions", "allow_multiple")
