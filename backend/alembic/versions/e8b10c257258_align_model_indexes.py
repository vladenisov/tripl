"""Align model indexes with the live schema and remove redundant indexes.

Revision ID: e8b10c257258
Revises: d7e4c1a95b30
"""

from alembic import op

revision: str = "e8b10c257258"
down_revision: str | None = "d7e4c1a95b30"
branch_labels: str | None = None
depends_on: str | None = None


_REDUNDANT_INDEXES = (
    (
        "ix_metric_anomaly_scope_bucket",
        "metric_anomalies",
        ("scan_config_id", "scope_type", "scope_ref", "bucket"),
    ),
    ("ix_coverage_metric_config_bucket", "coverage_metrics", ("scan_config_id", "bucket")),
    (
        "ix_metric_breakdown_anomaly_scope_bucket",
        "metric_breakdown_anomalies",
        (
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "breakdown_column",
            "breakdown_value",
            "is_other",
            "bucket",
        ),
    ),
    (
        "ix_release_regression_scan_scope",
        "release_regressions",
        ("scan_config_id", "scope_type", "scope_ref"),
    ),
    ("ix_alert_pending_item_destination", "alert_pending_items", ("destination_id",)),
    ("ix_event_photo_comment_event", "event_photo_comments", ("event_id",)),
    ("ix_variable_values_variable", "variable_values", ("variable_id",)),
)


def upgrade() -> None:
    op.create_index("ix_search_documents_branch_id", "search_documents", ["branch_id"])
    op.execute(
        "ALTER INDEX ix_plan_branch_approval_branch RENAME TO ix_plan_branch_approvals_branch_id"
    )
    op.execute(
        "ALTER INDEX ix_plan_branch_reviewer_branch RENAME TO ix_plan_branch_reviewers_branch_id"
    )
    for name, table, _columns in _REDUNDANT_INDEXES:
        op.drop_index(name, table_name=table)


def downgrade() -> None:
    for name, table, columns in reversed(_REDUNDANT_INDEXES):
        op.create_index(name, table, list(columns))
    op.execute(
        "ALTER INDEX ix_plan_branch_reviewers_branch_id RENAME TO ix_plan_branch_reviewer_branch"
    )
    op.execute(
        "ALTER INDEX ix_plan_branch_approvals_branch_id RENAME TO ix_plan_branch_approval_branch"
    )
    op.drop_index("ix_search_documents_branch_id", table_name="search_documents")
