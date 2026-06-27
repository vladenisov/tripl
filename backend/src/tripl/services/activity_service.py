from __future__ import annotations

from datetime import datetime

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
)
from tripl.models.alert_delivery import AlertDelivery
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob
from tripl.schemas.activity import ActivityItemResponse
from tripl.services.project_lookup import get_project_id_by_slug


async def list_activity(
    session: AsyncSession,
    *,
    slug: str | None = None,
    limit: int = 20,
) -> list[ActivityItemResponse]:
    if slug is not None:
        await get_project_id_by_slug(session, slug)

    items: list[ActivityItemResponse] = []
    items.extend(await _anomaly_items(session, slug=slug, limit=limit))
    items.extend(await _scan_job_items(session, slug=slug, limit=limit))
    items.extend(await _alert_delivery_items(session, slug=slug, limit=limit))
    items.extend(await _event_items(session, slug=slug, limit=limit))

    return sorted(items, key=lambda item: item.occurred_at, reverse=True)[:limit]


async def _anomaly_items(
    session: AsyncSession,
    *,
    slug: str | None,
    limit: int,
) -> list[ActivityItemResponse]:
    stmt = (
        select(
            MetricAnomaly.id,
            MetricAnomaly.scope_type,
            MetricAnomaly.scope_ref,
            MetricAnomaly.actual_count,
            MetricAnomaly.expected_count,
            MetricAnomaly.z_score,
            MetricAnomaly.direction,
            MetricAnomaly.created_at,
            Project.id.label("project_id"),
            Project.slug,
            Project.name.label("project_name"),
            ScanConfig.name.label("scan_name"),
            Event.name.label("event_name"),
            EventType.display_name.label("event_type_name"),
        )
        .join(ScanConfig, ScanConfig.id == MetricAnomaly.scan_config_id)
        .join(Project, Project.id == ScanConfig.project_id)
        .outerjoin(Event, Event.id == MetricAnomaly.event_id)
        .outerjoin(EventType, EventType.id == MetricAnomaly.event_type_id)
        .order_by(desc(MetricAnomaly.created_at), desc(MetricAnomaly.id))
        .limit(limit)
    )
    if slug is not None:
        stmt = stmt.where(Project.slug == slug)

    rows = (await session.execute(stmt)).all()
    items: list[ActivityItemResponse] = []
    for row in rows:
        scope_name = _scope_name(
            row.scope_type,
            event_name=row.event_name,
            event_type_name=row.event_type_name,
            project_name=row.project_name,
        )
        expected = round(float(row.expected_count))
        z_score = float(row.z_score)
        direction = str(row.direction)
        items.append(
            ActivityItemResponse(
                id=f"anomaly:{row.id}",
                project_id=row.project_id,
                project_slug=row.slug,
                project_name=row.project_name,
                type="anomaly",
                severity="high" if abs(z_score) >= 4 else "medium",
                title=f"{direction.capitalize()} on {scope_name}",
                detail=(
                    f"{int(row.actual_count):,} actual vs {expected:,} expected · z={z_score:.1f}"
                ),
                occurred_at=row.created_at,
                target_path=_monitoring_path(row.slug, row.scope_type, row.scope_ref),
            )
        )
    return items


async def _scan_job_items(
    session: AsyncSession,
    *,
    slug: str | None,
    limit: int,
) -> list[ActivityItemResponse]:
    occurred_at = func.coalesce(ScanJob.completed_at, ScanJob.started_at, ScanJob.updated_at)
    stmt = (
        select(
            ScanJob.id,
            ScanJob.status,
            ScanJob.result_summary,
            ScanJob.error_message,
            occurred_at.label("occurred_at"),
            Project.id.label("project_id"),
            Project.slug,
            Project.name.label("project_name"),
            ScanConfig.name.label("scan_name"),
        )
        .join(ScanConfig, ScanConfig.id == ScanJob.scan_config_id)
        .join(Project, Project.id == ScanConfig.project_id)
        .order_by(desc(occurred_at), desc(ScanJob.id))
        .limit(limit)
    )
    if slug is not None:
        stmt = stmt.where(Project.slug == slug)

    rows = (await session.execute(stmt)).all()
    items: list[ActivityItemResponse] = []
    for row in rows:
        status = str(row.status)
        items.append(
            ActivityItemResponse(
                id=f"scan-job:{row.id}",
                project_id=row.project_id,
                project_slug=row.slug,
                project_name=row.project_name,
                type="scan",
                severity=_scan_job_severity(status),
                title=f"Scan {status}: {row.scan_name}",
                detail=_scan_job_detail(status, row.result_summary, row.error_message),
                occurred_at=row.occurred_at,
                target_path=f"/p/{row.slug}/settings/scans",
            )
        )
    return items


async def _alert_delivery_items(
    session: AsyncSession,
    *,
    slug: str | None,
    limit: int,
) -> list[ActivityItemResponse]:
    occurred_at = func.coalesce(AlertDelivery.sent_at, AlertDelivery.updated_at)
    stmt = (
        select(
            AlertDelivery.id,
            AlertDelivery.status,
            AlertDelivery.channel,
            AlertDelivery.matched_count,
            AlertDelivery.error_message,
            occurred_at.label("occurred_at"),
            Project.id.label("project_id"),
            Project.slug,
            Project.name.label("project_name"),
            AlertDestination.name.label("destination_name"),
            AlertRule.name.label("rule_name"),
        )
        .join(Project, Project.id == AlertDelivery.project_id)
        .join(AlertDestination, AlertDestination.id == AlertDelivery.destination_id)
        .join(AlertRule, AlertRule.id == AlertDelivery.rule_id)
        .order_by(desc(occurred_at), desc(AlertDelivery.id))
        .limit(limit)
    )
    if slug is not None:
        stmt = stmt.where(Project.slug == slug)

    rows = (await session.execute(stmt)).all()
    items: list[ActivityItemResponse] = []
    for row in rows:
        status = str(row.status)
        items.append(
            ActivityItemResponse(
                id=f"alert-delivery:{row.id}",
                project_id=row.project_id,
                project_slug=row.slug,
                project_name=row.project_name,
                type="alert",
                severity=_alert_delivery_severity(status),
                title=f"Alert {status}: {row.rule_name}",
                detail=_alert_delivery_detail(
                    status=status,
                    channel=row.channel,
                    matched_count=row.matched_count,
                    destination_name=row.destination_name,
                    error_message=row.error_message,
                ),
                occurred_at=row.occurred_at,
                target_path=f"/p/{row.slug}/settings/alerting",
            )
        )
    return items


async def _event_items(
    session: AsyncSession,
    *,
    slug: str | None,
    limit: int,
) -> list[ActivityItemResponse]:
    stmt = (
        select(
            Event.id,
            Event.name,
            Event.status,
            Event.created_at,
            Event.updated_at,
            Project.id.label("project_id"),
            Project.slug,
            Project.name.label("project_name"),
            EventType.display_name.label("event_type_name"),
        )
        .join(Project, Project.id == Event.project_id)
        .join(EventType, EventType.id == Event.event_type_id)
        .order_by(desc(Event.updated_at), desc(Event.id))
        .limit(limit)
    )
    if slug is not None:
        stmt = stmt.where(Project.slug == slug)

    rows = (await session.execute(stmt)).all()
    items: list[ActivityItemResponse] = []
    for row in rows:
        title, detail, severity = _event_copy(
            name=row.name,
            event_type_name=row.event_type_name,
            status=str(row.status),
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        items.append(
            ActivityItemResponse(
                id=f"event:{row.id}",
                project_id=row.project_id,
                project_slug=row.slug,
                project_name=row.project_name,
                type="event",
                severity=severity,
                title=title,
                detail=detail,
                occurred_at=row.updated_at,
                target_path=f"/p/{row.slug}/monitoring/event/{row.id}",
            )
        )
    return items


def _scope_name(
    scope_type: str,
    *,
    event_name: str | None,
    event_type_name: str | None,
    project_name: str,
) -> str:
    if scope_type == SCOPE_EVENT:
        return event_name or "event"
    if scope_type == SCOPE_EVENT_TYPE:
        return event_type_name or "event type"
    if scope_type == SCOPE_PROJECT_TOTAL:
        return f"{project_name} total"
    return "metric"


def _monitoring_path(slug: str, scope_type: str, scope_ref: str) -> str | None:
    if scope_type == SCOPE_PROJECT_TOTAL:
        return f"/p/{slug}/monitoring/project-total/{scope_ref}"
    if scope_type == SCOPE_EVENT_TYPE:
        return f"/p/{slug}/monitoring/event-type/{scope_ref}"
    if scope_type == SCOPE_EVENT:
        return f"/p/{slug}/monitoring/event/{scope_ref}"
    return None


def _scan_job_severity(status: str) -> str:
    if status == "failed":
        return "high"
    if status in {"running", "pending"}:
        return "medium"
    return "low"


def _scan_job_detail(
    status: str,
    result_summary: dict[str, object] | None,
    error_message: str | None,
) -> str:
    if status == "failed" and error_message:
        return error_message

    summary = result_summary or {}
    parts: list[str] = []
    if summary.get("events_created") is not None:
        parts.append(f"{summary['events_created']} events created")
    if summary.get("signals_added"):
        parts.append(f"{summary['signals_added']} signals")
    if summary.get("alerts_queued"):
        parts.append(f"{summary['alerts_queued']} alerts queued")
    if parts:
        return " · ".join(parts)
    return "Metrics collection job updated" if status == "completed" else "Scan job status changed"


def _alert_delivery_severity(status: str) -> str:
    if status == "failed":
        return "high"
    if status == "pending":
        return "medium"
    return "low"


def _alert_delivery_detail(
    *,
    status: str,
    channel: str,
    matched_count: int,
    destination_name: str,
    error_message: str | None,
) -> str:
    if status == "failed" and error_message:
        return error_message
    matched = (
        f"{matched_count} matched signal"
        if matched_count == 1
        else f"{matched_count} matched signals"
    )
    return f"{matched} · {channel} · {destination_name}"


def _event_copy(
    *,
    name: str,
    event_type_name: str,
    status: str,
    created_at: datetime,
    updated_at: datetime,
) -> tuple[str, str, str]:
    if status == "archived":
        return f"Event archived: {name}", event_type_name, "low"
    if status == "in_review":
        return f"Event needs review: {name}", event_type_name, "medium"
    if status in ("implemented", "live"):
        return f"Event implemented: {name}", event_type_name, "low"
    if updated_at != created_at:
        return f"Event updated: {name}", event_type_name, "low"
    return f"Event added: {name}", event_type_name, "low"
