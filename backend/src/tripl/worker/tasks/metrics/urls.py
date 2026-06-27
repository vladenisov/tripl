"""URL builders + small text helpers used by alert payloads."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.alerting_matching import SCOPE_DISTRIBUTION_DRIFT
from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
)
from tripl.models.project import Project
from tripl.services import app_settings_service

from ._helpers import SCOPE_SCHEMA_DRIFT


def _build_monitoring_url(
    project_slug: str,
    *,
    scope_type: str,
    scope_ref: str,
) -> str | None:
    app_base_url = app_settings_service.get_runtime_config_sync().app_base_url
    if not app_base_url:
        return None
    base = app_base_url.rstrip("/")
    if scope_type == SCOPE_PROJECT_TOTAL:
        return f"{base}/p/{project_slug}/monitoring/project-total/{scope_ref}"
    if scope_type == SCOPE_EVENT_TYPE:
        return f"{base}/p/{project_slug}/monitoring/event-type/{scope_ref}"
    if scope_type in {SCOPE_SCHEMA_DRIFT, SCOPE_DISTRIBUTION_DRIFT}:
        return None
    return f"{base}/p/{project_slug}/monitoring/event/{scope_ref}"


def _build_event_details_url(project_slug: str, event_id: uuid.UUID | None) -> str | None:
    app_base_url = app_settings_service.get_runtime_config_sync().app_base_url
    if not app_base_url or event_id is None:
        return None
    base = app_base_url.rstrip("/")
    return f"{base}/p/{project_slug}/monitoring/event/{event_id}"


def _get_project_slug(session: Session, project_id: uuid.UUID) -> str:
    slug = session.execute(
        select(Project.slug).where(Project.id == project_id)
    ).scalar_one_or_none()
    if slug is None:
        msg = f"Project {project_id} not found"
        raise ValueError(msg)
    return slug


def _trim_alert_text(value: str | None, *, max_length: int = 500) -> str | None:
    if value is None or len(value) <= max_length:
        return value
    return value[: max_length - 3] + "..."
