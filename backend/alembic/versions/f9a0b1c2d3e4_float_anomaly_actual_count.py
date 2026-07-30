"""anomaly + alert-delivery value columns to Float

Revision ID: f9a0b1c2d3e4
Revises: f8a9b0c1d2e3
Create Date: 2026-07-03 00:00:00.000000

Fractional catalog metrics (ratios / averages / sql levels) produce sub-unit
actuals that integer columns round away (tripl-68bc). Volume scopes keep
writing whole counts into the same columns; double precision represents every
count they realistically reach exactly. Covers the anomaly stores and the
alert-delivery items derived from them.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f9a0b1c2d3e4"
down_revision: str | None = "f8a9b0c1d2e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# table -> (columns, integer type to restore on downgrade)
_COLUMNS: dict[str, tuple[tuple[str, ...], type[sa.BigInteger] | type[sa.Integer]]] = {
    "metric_anomalies": (("actual_count",), sa.BigInteger),
    "metric_breakdown_anomalies": (("actual_count",), sa.BigInteger),
    "alert_delivery_items": (
        ("actual_count", "expected_count", "absolute_delta"),
        sa.Integer,
    ),
}


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for table, (columns, _int_type) in _COLUMNS.items():
        for column in columns:
            op.alter_column(
                table,
                column,
                type_=sa.Float(),
                postgresql_using=f"{column}::double precision",
            )


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    # Intentional precision loss: fractional values round back to whole counts.
    for table, (columns, int_type) in _COLUMNS.items():
        cast_to = "bigint" if int_type is sa.BigInteger else "integer"
        for column in columns:
            op.alter_column(
                table,
                column,
                type_=int_type(),
                postgresql_using=f"round({column})::{cast_to}",
            )
