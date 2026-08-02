from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

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
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob
from tripl.schemas.activity import ActivityItemResponse
from tripl.services.project_lookup import get_project_id_by_slug

# The activity rail surfaces "recent" signals, not the full anomaly history.
# Without a window, weeks-old high-z anomalies stay ordered at the top of the
# feed on every page and read as live/streaming events. Bound the query to a
# recent window measured against wall-clock now so only fresh anomalies show.
ANOMALY_RECENCY_WINDOW = timedelta(days=7)


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
            MetricAnomaly.scan_config_id,
            MetricAnomaly.scope_type,
            MetricAnomaly.scope_ref,
            MetricAnomaly.bucket,
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
            Event.id.label("resolved_event_id"),
            PlanBranch.kind.label("branch_kind"),
            EventType.display_name.label("event_type_name"),
        )
        .join(ScanConfig, ScanConfig.id == MetricAnomaly.scan_config_id)
        .join(Project, Project.id == ScanConfig.project_id)
        .outerjoin(Event, Event.id == MetricAnomaly.event_id)
        .outerjoin(PlanBranch, PlanBranch.id == Event.branch_id)
        .outerjoin(EventType, EventType.id == MetricAnomaly.event_type_id)
        .where(MetricAnomaly.created_at >= datetime.now(UTC) - ANOMALY_RECENCY_WINDOW)
        .order_by(desc(MetricAnomaly.created_at), desc(MetricAnomaly.id))
        .limit(limit)
    )
    if slug is not None:
        stmt = stmt.where(Project.slug == slug)

    rows = (await session.execute(stmt)).all()

    # One incident is one rail item: a project-total spike/drop trips its child
    # event_type/event scopes on the same scan, bucket and direction. Surface
    # only the parent project_total row and suppress the co-firing children so a
    # single incident does not stack into many rail entries. This is layered on
    # top of Wave 1's wall-clock recency filter (kept above), not a replacement.
    parent_incidents = {
        (row.scan_config_id, row.bucket, str(row.direction))
        for row in rows
        if row.scope_type == SCOPE_PROJECT_TOTAL
    }

    items: list[ActivityItemResponse] = []
    for row in rows:
        if (
            row.scope_type in (SCOPE_EVENT_TYPE, SCOPE_EVENT)
            and (row.scan_config_id, row.bucket, str(row.direction)) in parent_incidents
        ):
            continue
        scope_name = _scope_name(
            row.scope_type,
            event_name=row.event_name,
            event_type_name=row.event_type_name,
            project_name=row.project_name,
        )
        expected = round(float(row.expected_count))
        z_score = float(row.z_score)
        direction = str(row.direction)
        # Only an event still on the live plan gives a route the monitoring page
        # can resolve; a deleted or branch-local one leaves the row unlinked.
        main_branch_event_id = (
            row.resolved_event_id if row.branch_kind == BranchKind.main.value else None
        )
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
                target_path=_anomaly_target_path(
                    row.slug,
                    row.scope_type,
                    row.scope_ref,
                    main_branch_event_id=main_branch_event_id,
                ),
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
        # Main branch only. Event is branch-scoped and a working branch
        # deep-copies every plan entity with fresh ids, so without this the rail
        # emitted branch-local event ids that /monitoring/event/:id 404s on (it
        # resolves against main) and listed every event once per open branch,
        # splitting the window between duplicate copies (tripl-r5ri). Same
        # cause as metrics_service.get_overview_kpi_series' scoping. The join
        # keeps off-main rows out of the result set rather than filtering them
        # in Python, and never writes (ensure_main_branch_id does).
        .join(PlanBranch, PlanBranch.id == Event.branch_id)
        .where(PlanBranch.kind == BranchKind.main.value)
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
                target_path=_event_detail_path(row.slug, row.id),
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


def _event_detail_path(slug: str, event_id: uuid.UUID | str) -> str:
    """The one place the rail mints an event drilldown route.

    Both the event and the anomaly rail items link to the same page, so the
    branch scoping that keeps these ids resolvable has a single route to guard.
    """
    return f"/p/{slug}/monitoring/event/{event_id}"


def _monitoring_path(slug: str, scope_type: str, scope_ref: str) -> str | None:
    if scope_type == SCOPE_PROJECT_TOTAL:
        return f"/p/{slug}/monitoring/project-total/{scope_ref}"
    if scope_type == SCOPE_EVENT_TYPE:
        return f"/p/{slug}/monitoring/event-type/{scope_ref}"
    if scope_type == SCOPE_EVENT:
        return _event_detail_path(slug, scope_ref)
    return None


def _anomaly_target_path(
    slug: str,
    scope_type: str,
    scope_ref: str,
    *,
    main_branch_event_id: uuid.UUID | None,
) -> str | None:
    """Route an anomaly rail item, resolving event scopes through the FK.

    ``MetricAnomaly.scope_ref`` is an unconstrained String while the real FK
    ``event_id`` is ``ondelete="SET NULL"``, so a deleted event leaves a stale
    uuid in ``scope_ref`` and routing off it emitted a dead drilldown. Route
    event scopes from the resolved main-branch ``Event.id`` instead and drop the
    link when it no longer resolves — both rail consumers render an unlinked row
    for a null ``target_path``. Other scopes are unaffected.
    """
    if scope_type == SCOPE_EVENT:
        if main_branch_event_id is None:
            return None
        return _event_detail_path(slug, main_branch_event_id)
    return _monitoring_path(slug, scope_type, scope_ref)


def _scan_job_severity(status: str) -> str:
    if status == "failed":
        return "high"
    if status in {"running", "pending"}:
        return "medium"
    return "low"


# Metric-point (time-series ROW) scopes a completed run writes. Summed rather
# than surfaced individually, and kept in sync with the frontend
# ``summarizeScanChanges`` (scanUtils.ts) so the activity rail and the Scans page
# agree on what a run produced.
_METRIC_POINT_KEYS = (
    "event_metrics",
    "type_metrics",
    "breakdown_event_metrics",
    "breakdown_type_metrics",
)
# Fields the backend may populate for rows read, in preference order.
_ROWS_SCANNED_KEYS = ("query_rows_scanned", "scan_rows_processed")


def _as_positive_count(value: object) -> int:
    """Coerce a JSON result-summary value to a positive int, else 0.

    ``bool`` is rejected explicitly: it is an ``int`` subclass in Python, and a
    stray boolean flag must never be counted as a quantity.
    """
    if isinstance(value, bool):
        return 0
    if isinstance(value, int) and value > 0:
        return value
    return 0


def _count_label(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


def _metric_points_written(summary: dict[str, object]) -> int:
    return sum(_as_positive_count(summary.get(key)) for key in _METRIC_POINT_KEYS)


def _rows_scanned(summary: dict[str, object]) -> int:
    for key in _ROWS_SCANNED_KEYS:
        rows = _as_positive_count(summary.get(key))
        if rows:
            return rows
    return 0


def _scan_job_detail(
    status: str,
    result_summary: dict[str, object] | None,
    error_message: str | None,
) -> str:
    if status == "failed" and error_message:
        return error_message

    summary = result_summary or {}
    # Lead with what the run actually produced. A completed scan on an
    # established catalog routinely discovers 0 new events yet still writes
    # metric points and scans rows; surfacing a bare "0 events created" made a
    # healthy run read as a no-op / failure (tripl-yfsj.5). Only non-zero deltas
    # are shown, mirroring the frontend Scans-page summary.
    parts: list[str] = []
    events_created = _as_positive_count(summary.get("events_created"))
    if events_created:
        parts.append(_count_label(events_created, "new event", "new events"))
    metric_points = _metric_points_written(summary)
    if metric_points:
        parts.append(_count_label(metric_points, "metric point", "metric points"))
    signals_added = _as_positive_count(summary.get("signals_added"))
    if signals_added:
        # "new signal(s)", not "signal(s)": this is the run's signals_added
        # DELTA, and a bare "1 signal" read as the project's open-signal total —
        # irreconcilable with the Anomalies headline (tripl-jfm3.27). Matches the
        # events_created branch above, which already qualifies its delta.
        parts.append(_count_label(signals_added, "new signal", "new signals"))
    alerts_queued = _as_positive_count(summary.get("alerts_queued"))
    if alerts_queued:
        parts.append(_count_label(alerts_queued, "alert queued", "alerts queued"))

    # A completed run that created nothing new is normal, not a failure: say so
    # explicitly rather than falling back to a vague status line.
    if not parts and status == "completed" and "events_created" in summary:
        parts.append("no new events discovered")

    rows_scanned = _rows_scanned(summary)
    if rows_scanned:
        parts.append(_count_label(rows_scanned, "row scanned", "rows scanned"))

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
