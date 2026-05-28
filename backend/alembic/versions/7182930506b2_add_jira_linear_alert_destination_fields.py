"""add jira and linear alert destination fields

Revision ID: 7182930506b2
Revises: 6071829305a1
Create Date: 2026-05-28 17:00:00.000000

Adds per-destination fields for Jira (REST v3) and Linear (GraphQL) ticketing
channels. Both store their API credentials in a *_encrypted Text column; other
identifiers (project key, team id, etc.) are plain strings since they are
non-secret and the API rejects malformed values at write time.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "7182930506b2"
down_revision = "6071829305a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Jira columns
    op.add_column(
        "alert_destinations",
        sa.Column("jira_base_url", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("jira_auth_email", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("jira_api_token_encrypted", sa.Text(), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("jira_project_key", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("jira_issue_type", sa.String(length=64), nullable=True),
    )
    # Linear columns
    op.add_column(
        "alert_destinations",
        sa.Column("linear_api_key_encrypted", sa.Text(), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("linear_team_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "alert_destinations",
        sa.Column("linear_state_id", sa.String(length=64), nullable=True),
    )
    # Comma-separated label ids — small list per destination, no need to
    # normalize into its own table for v1.
    op.add_column(
        "alert_destinations",
        sa.Column("linear_label_ids", sa.String(length=1024), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("alert_destinations", "linear_label_ids")
    op.drop_column("alert_destinations", "linear_state_id")
    op.drop_column("alert_destinations", "linear_team_id")
    op.drop_column("alert_destinations", "linear_api_key_encrypted")
    op.drop_column("alert_destinations", "jira_issue_type")
    op.drop_column("alert_destinations", "jira_project_key")
    op.drop_column("alert_destinations", "jira_api_token_encrypted")
    op.drop_column("alert_destinations", "jira_auth_email")
    op.drop_column("alert_destinations", "jira_base_url")
