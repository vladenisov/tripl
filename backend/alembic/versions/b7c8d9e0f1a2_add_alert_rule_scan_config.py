"""add alert_rules.scan_config_id

Lets a rule be narrowed to a single scan. NULL — what every existing row gets —
means the whole project, which is exactly the behaviour rules have always had,
so this migration is a no-op for every rule already configured.

``ondelete`` is SET NULL rather than CASCADE: deleting a scan must not delete an
alert rule (its name, thresholds, templates and filters) nor, through
``alert_deliveries.rule_id``, its delivery history. ``scan_service.
delete_scan_config`` disables the rules it unbinds in the same transaction, so a
rule narrowed to a deleted scan goes inert instead of silently widening back to
the project.

Revision ID: b7c8d9e0f1a2
Revises: d2c3b4a5f6e7
Create Date: 2026-08-06 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7c8d9e0f1a2"
down_revision: str | None = "d2c3b4a5f6e7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("alert_rules", sa.Column("scan_config_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_alert_rules_scan_config_id",
        "alert_rules",
        "scan_configs",
        ["scan_config_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_alert_rule_scan_config", "alert_rules", ["scan_config_id"])


def downgrade() -> None:
    op.drop_index("ix_alert_rule_scan_config", table_name="alert_rules")
    op.drop_constraint("fk_alert_rules_scan_config_id", "alert_rules", type_="foreignkey")
    op.drop_column("alert_rules", "scan_config_id")
