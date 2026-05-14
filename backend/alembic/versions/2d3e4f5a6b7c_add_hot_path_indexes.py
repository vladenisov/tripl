"""add hot-path indexes

Revision ID: 2d3e4f5a6b7c
Revises: 2c3d4e5f6a7b
Create Date: 2026-04-24

Adds missing btree indexes on foreign-key columns that drive the biggest
hot paths in the app:

- events(project_id, order) — list_events ORDER BY order within project
- events(event_type_id) — filter by event type
- scan_configs(project_id) — list scans per project
- scan_jobs(scan_config_id) — fetch jobs per scan config
- event_tags(name) — tag filter in list_events / tag autocomplete

Each child table's FK to events is already covered by existing UNIQUE
constraints that start with event_id (event_field_values, event_meta_values,
event_tags), so no extra indexes needed there.
"""

from __future__ import annotations

from alembic import op

revision = "2d3e4f5a6b7c"
down_revision = "2c3d4e5f6a7b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_event_project_order", "events", ["project_id", "order"])
    op.create_index("ix_event_event_type", "events", ["event_type_id"])
    op.create_index("ix_scan_config_project", "scan_configs", ["project_id"])
    op.create_index("ix_scan_job_config", "scan_jobs", ["scan_config_id"])
    op.create_index("ix_event_tag_name", "event_tags", ["name"])


def downgrade() -> None:
    op.drop_index("ix_event_tag_name", table_name="event_tags")
    op.drop_index("ix_scan_job_config", table_name="scan_jobs")
    op.drop_index("ix_scan_config_project", table_name="scan_configs")
    op.drop_index("ix_event_event_type", table_name="events")
    op.drop_index("ix_event_project_order", table_name="events")
