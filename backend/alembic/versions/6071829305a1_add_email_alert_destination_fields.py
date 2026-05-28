"""add email alert destination fields

Revision ID: 6071829305a1
Revises: 5f607182930a
Create Date: 2026-05-28 16:00:00.000000

Adds optional per-destination email fields. SMTP credentials remain instance-level
(see settings.smtp_*) so destinations only carry the recipient list and optional
from-address / subject-template overrides.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "6071829305a1"
down_revision = "5f607182930a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "alert_destinations",
        sa.Column("email_recipients", sa.Text(), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("email_from_address", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("email_subject_template", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("alert_destinations", "email_subject_template")
    op.drop_column("alert_destinations", "email_from_address")
    op.drop_column("alert_destinations", "email_recipients")
