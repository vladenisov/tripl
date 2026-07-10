"""add variable value drift alert scope

Revision ID: d1c2b3a4f5e6
Revises: b4a3c2d1e0f9
Create Date: 2026-07-10 12:00:00.000000

* ``metric_scope_type`` gains ``'variable_value_drift'`` (autocommit block —
  Postgres cannot ``ALTER TYPE ... ADD VALUE`` inside a transaction on every
  supported version; mirrors a1b2c3d4e5f6).
* ``alert_rules.include_variable_value_drifts`` (default OFF) gates delivery.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d1c2b3a4f5e6"
down_revision: str | None = "b4a3c2d1e0f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        with op.get_context().autocommit_block():
            op.execute(
                "ALTER TYPE metric_scope_type ADD VALUE IF NOT EXISTS 'variable_value_drift'"
            )

    op.add_column(
        "alert_rules",
        sa.Column(
            "include_variable_value_drifts",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )


def downgrade() -> None:
    # The enum value is left in place (Postgres cannot drop enum values).
    op.drop_column("alert_rules", "include_variable_value_drifts")
