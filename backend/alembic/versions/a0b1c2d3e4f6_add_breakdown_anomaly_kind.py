"""add volume/parity kind to breakdown anomalies

Revision ID: a0b1c2d3e4f6
Revises: f5e6d7c8b9a0
Create Date: 2026-07-11 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a0b1c2d3e4f6"
down_revision: str | None = "f5e6d7c8b9a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ENUM_NAME = "metric_breakdown_anomaly_kind"
_CONSTRAINT_NAME = "uq_metric_breakdown_anomaly_scope_bucket_value"
_SCOPE_COLUMNS = (
    "scan_config_id",
    "scope_type",
    "scope_ref",
    "breakdown_column",
    "breakdown_value",
    "is_other",
    "bucket",
)


def upgrade() -> None:
    bind = op.get_bind()
    postgresql.ENUM("volume", "parity", name=_ENUM_NAME).create(bind, checkfirst=True)
    kind_enum = postgresql.ENUM(
        "volume",
        "parity",
        name=_ENUM_NAME,
        create_type=False,
    )
    op.add_column(
        "metric_breakdown_anomalies",
        sa.Column(
            "kind",
            kind_enum,
            server_default=sa.text("'volume'"),
            nullable=False,
        ),
    )
    op.drop_constraint(
        _CONSTRAINT_NAME,
        "metric_breakdown_anomalies",
        type_="unique",
    )
    op.create_unique_constraint(
        _CONSTRAINT_NAME,
        "metric_breakdown_anomalies",
        [*_SCOPE_COLUMNS, "kind"],
    )


def downgrade() -> None:
    op.drop_constraint(
        _CONSTRAINT_NAME,
        "metric_breakdown_anomalies",
        type_="unique",
    )
    op.execute("DELETE FROM metric_breakdown_anomalies WHERE kind = 'parity'")
    op.create_unique_constraint(
        _CONSTRAINT_NAME,
        "metric_breakdown_anomalies",
        list(_SCOPE_COLUMNS),
    )
    op.drop_column("metric_breakdown_anomalies", "kind")
    postgresql.ENUM(name=_ENUM_NAME).drop(op.get_bind(), checkfirst=True)
