"""Message-building helpers for alert deliveries.

Pure rendering/formatting logic extracted from alerts.py so that module stays
under a manageable size.  Nothing here touches Celery or outbound HTTP — all
I/O lives in alerts.py.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tripl.alert_templates import (
    ALERT_MESSAGE_FORMAT_PLAIN,
    AlertTemplateContext,
    escape_alert_value,
    get_default_items_template,
    get_default_message_template,
    normalize_message_template,
    render_alert_template,
)
from tripl.anomaly_context import build_alert_item_context
from tripl.models.alert_delivery import AlertDelivery
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event, EventStatus
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift
from tripl.services import app_settings_service, llm_service

logger = logging.getLogger(__name__)

DIGEST_WINDOW_DAYS = 7
DEAD_EVENT_DAYS = 30

_AI_EXPLANATION_MAX_ITEMS = 10
_AI_EXPLANATION_MAX_TOKENS = 250


def _build_item_template_context(
    item: AlertDeliveryItem,
    *,
    message_format: str,
    session: Session | None = None,
    scan_config_id: uuid.UUID | None = None,
    item_context_cache: dict[uuid.UUID, tuple[str, str]] | None = None,
) -> AlertTemplateContext:
    scope_label = {
        "project_total": "Project total",
        "event_type": "Event type",
        "event": "Event",
        "schema": "Schema drift",
        "distribution": "Distribution drift",
    }.get(item.scope_type, item.scope_type)
    details_line = f"\n  details: {item.details_path}" if item.details_path else ""
    monitoring_line = f"\n  monitoring: {item.monitoring_path}" if item.monitoring_path else ""
    drift_parts = [
        item.drift_type or "",
        item.drift_field or "",
        f"sample={item.sample_value}" if item.sample_value else "",
    ]
    drift_text = " ".join(part for part in drift_parts if part)
    drift_line = f"\n  drift: {drift_text}" if drift_text else ""

    # Explainability context — sparkline + top movers. The (sparkline,
    # top_movers) pair is format-independent and the only DB-touching part of
    # the render, so we cache it per item: a re-render in a different format
    # (e.g. the MarkdownV2→plain fallback) reuses it instead of re-querying.
    sparkline = ""
    top_movers = ""
    cached = item_context_cache.get(item.id) if item_context_cache is not None else None
    if cached is not None:
        sparkline, top_movers = cached
    elif session is not None and scan_config_id is not None:
        try:
            sparkline, top_movers = build_alert_item_context(
                session,
                scan_config_id=scan_config_id,
                scope_type=item.scope_type,
                scope_ref=item.scope_ref,
                bucket=item.bucket,
            )
        except Exception:  # noqa: BLE001
            logger.warning("Failed to build alert item context", exc_info=True)
        if item_context_cache is not None:
            item_context_cache[item.id] = (sparkline, top_movers)
    sparkline_line = f"\n  trend: {sparkline}" if sparkline else ""
    top_movers_line = f"\n  movers: {top_movers}" if top_movers else ""

    variables = {
        "scope_name": escape_alert_value(item.scope_name, message_format),
        "scope_type": escape_alert_value(item.scope_type, message_format),
        "scope_label": escape_alert_value(scope_label, message_format),
        "direction": escape_alert_value(item.direction, message_format),
        "direction_label": escape_alert_value(
            "up" if item.direction == "spike" else "down",
            message_format,
        ),
        "actual_count": escape_alert_value(item.actual_count, message_format),
        "expected_count": escape_alert_value(item.expected_count, message_format),
        "absolute_delta": escape_alert_value(item.absolute_delta, message_format),
        "percent_delta": escape_alert_value(f"{item.percent_delta:.1f}", message_format),
        "bucket": escape_alert_value(item.bucket, message_format),
        "details_url": escape_alert_value(item.details_path or "", message_format),
        "monitoring_url": escape_alert_value(item.monitoring_path or "", message_format),
        "details_line": escape_alert_value(details_line, message_format),
        "monitoring_line": escape_alert_value(monitoring_line, message_format),
        "drift_field": escape_alert_value(item.drift_field or "", message_format),
        "drift_type": escape_alert_value(item.drift_type or "", message_format),
        "sample_value": escape_alert_value(item.sample_value or "", message_format),
        "drift_line": escape_alert_value(drift_line, message_format),
        "sparkline": escape_alert_value(sparkline, message_format),
        "top_movers": escape_alert_value(top_movers, message_format),
        "sparkline_line": escape_alert_value(sparkline_line, message_format),
        "top_movers_line": escape_alert_value(top_movers_line, message_format),
    }
    return AlertTemplateContext(variables=variables, message_format=message_format)


def _build_items_text(
    items: list[AlertDeliveryItem],
    *,
    message_format: str,
    items_template: str,
    session: Session | None = None,
    scan_config_id: uuid.UUID | None = None,
    item_context_cache: dict[uuid.UUID, tuple[str, str]] | None = None,
) -> str:
    lines: list[str] = []
    for item in items:
        rendered_item = render_alert_template(
            items_template,
            _build_item_template_context(
                item,
                message_format=message_format,
                session=session,
                scan_config_id=scan_config_id,
                item_context_cache=item_context_cache,
            ),
        ).rstrip()
        if rendered_item:
            lines.append(rendered_item)
    return "\n".join(lines)


def _build_template_context(
    delivery: AlertDelivery,
    *,
    destination: AlertDestination,
    rule: AlertRule,
    scan_name: str,
    project: Project | None,
    message_format_override: str | None = None,
    session: Session | None = None,
    item_context_cache: dict[uuid.UUID, tuple[str, str]] | None = None,
) -> AlertTemplateContext:
    message_format = message_format_override or rule.message_format or ALERT_MESSAGE_FORMAT_PLAIN
    items_template = normalize_message_template(rule.items_template)
    if items_template is None:
        items_template = get_default_items_template(message_format)

    variables = {
        "project_name": escape_alert_value(project.name if project else "", message_format),
        "project_slug": escape_alert_value(project.slug if project else "", message_format),
        "channel": escape_alert_value(destination.type, message_format),
        "destination_name": escape_alert_value(destination.name, message_format),
        "rule_name": escape_alert_value(rule.name, message_format),
        "scan_name": escape_alert_value(scan_name, message_format),
        "matched_count": escape_alert_value(delivery.matched_count, message_format),
        "items_count": escape_alert_value(delivery.matched_count, message_format),
        "items_text": _build_items_text(
            delivery.items,
            message_format=message_format,
            items_template=items_template,
            session=session,
            scan_config_id=delivery.scan_config_id,
            item_context_cache=item_context_cache,
        ),
    }
    return AlertTemplateContext(variables=variables, message_format=message_format)


def _render_delivery_message(
    delivery: AlertDelivery,
    *,
    destination: AlertDestination,
    rule: AlertRule,
    scan_name: str,
    project: Project | None,
    message_format_override: str | None = None,
    session: Session | None = None,
    item_context_cache: dict[uuid.UUID, tuple[str, str]] | None = None,
) -> tuple[str, str]:
    template = normalize_message_template(rule.message_template)
    context = _build_template_context(
        delivery,
        destination=destination,
        rule=rule,
        scan_name=scan_name,
        project=project,
        message_format_override=message_format_override,
        session=session,
        item_context_cache=item_context_cache,
    )
    if template is None:
        template = get_default_message_template(context.message_format)
    return render_alert_template(template, context).rstrip(), context.message_format


def _build_ai_explanation(
    delivery: AlertDelivery,
    *,
    scan_name: str,
    project_name: str,
    item_context_cache: dict[uuid.UUID, tuple[str, str]],
) -> str | None:
    """LLM summary of the delivery's items, or None when AI is off or fails.

    Reuses the (sparkline, top_movers) pairs already built for template
    rendering — no extra DB queries. Failure here must never block the alert,
    so any error degrades to None.
    """
    ai_config = app_settings_service.get_ai_config_sync()
    lines: list[str] = [f"Project: {project_name}", f"Scan: {scan_name}", "Alert items:"]
    for item in delivery.items[:_AI_EXPLANATION_MAX_ITEMS]:
        sparkline, top_movers = item_context_cache.get(item.id, ("", ""))
        if item.scope_type in {"schema", "distribution"}:
            drift_bits = " ".join(
                part
                for part in (
                    item.drift_type or "",
                    f"field={item.drift_field}" if item.drift_field else "",
                    f"sample={item.sample_value}" if item.sample_value else "",
                )
                if part
            )
            lines.append(f"- [{item.scope_type} drift] {item.scope_name}: {drift_bits}")
            continue
        line = (
            f"- [{item.scope_type}] {item.scope_name}: {item.direction}, "
            f"actual {item.actual_count} vs expected {item.expected_count} "
            f"({item.percent_delta:+.0f}%), bucket {item.bucket:%Y-%m-%d %H:%M}"
        )
        if sparkline:
            line += f", recent trend (old→new): {sparkline}"
        if top_movers:
            line += f", top movers: {top_movers}"
        if item.correlation_group_id is not None:
            line += " [co-fired with other items]"
        lines.append(line)
    try:
        raw = llm_service.complete(
            ai_config.alert_explanation_system_prompt,
            "\n".join(lines),
            max_tokens=_AI_EXPLANATION_MAX_TOKENS,
            temperature=0.3,
            config=ai_config,
        )
    except Exception:  # noqa: BLE001
        logger.warning("AI explanation generation failed", exc_info=True)
        return None
    if raw is None:
        return None
    explanation = raw.strip()
    return explanation or None


def _append_ai_explanation(text: str, explanation: str, message_format: str) -> str:
    return f"{text}\n\nAI: {escape_alert_value(explanation, message_format)}"


def _build_email_subject(
    *,
    template: str | None,
    rule: AlertRule,
    project: Project | None,
    matched_count: int,
    destination: AlertDestination,
    message_format: str,
) -> str:
    """Render the subject template. Falls back to a sensible default."""
    if template is None:
        prefix = project.name if project else "tripl"
        return f"[{prefix}] {rule.name} — {matched_count} alert(s)"
    variables = {
        "project_name": escape_alert_value(project.name if project else "", message_format),
        "project_slug": escape_alert_value(project.slug if project else "", message_format),
        "rule_name": escape_alert_value(rule.name, message_format),
        "destination_name": escape_alert_value(destination.name, message_format),
        "matched_count": escape_alert_value(matched_count, message_format),
    }
    rendered = render_alert_template(
        template,
        AlertTemplateContext(variables=variables, message_format=ALERT_MESSAGE_FORMAT_PLAIN),
    ).strip()
    # Subject MUST be single-line — strip any newline injection that snuck in.
    return rendered.replace("\r", " ").replace("\n", " ") or rule.name


def _build_jira_adf_body(text: str) -> dict[str, object]:
    """Render plain text as Atlassian Document Format (ADF).

    One paragraph per non-empty line is enough for the alert message — we don't
    need the full rich tree, just a structure Jira will accept and display as a
    multi-line ticket body.
    """
    paragraphs: list[dict[str, object]] = []
    for line in text.splitlines():
        if not line:
            paragraphs.append({"type": "paragraph", "content": []})
            continue
        paragraphs.append(
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": line}],
            }
        )
    if not paragraphs:
        paragraphs.append({"type": "paragraph", "content": []})
    return {"type": "doc", "version": 1, "content": paragraphs}


def _build_ticket_subject(
    *,
    rule: AlertRule,
    project: Project | None,
    matched_count: int,
) -> str:
    """Single-line summary for Jira / Linear titles. Matches the email subject
    default so all three ticket-style channels stay consistent."""
    prefix = project.name if project else "tripl"
    return f"[{prefix}] {rule.name} — {matched_count} alert(s)"


def _is_telegram_markdown_parse_error(error: Exception) -> bool:
    message = str(error).lower()
    return "can't parse entities" in message or "can't find end of" in message


def _webhook_item_payload(item: AlertDeliveryItem) -> dict[str, object]:
    return {
        "scope_type": item.scope_type,
        "scope_ref": item.scope_ref,
        "scope_name": item.scope_name,
        "direction": item.direction,
        "actual_count": item.actual_count,
        "expected_count": item.expected_count,
        "absolute_delta": item.absolute_delta,
        "percent_delta": item.percent_delta,
        "bucket": item.bucket.isoformat() if item.bucket else None,
        "details_url": item.details_path,
        "monitoring_url": item.monitoring_path,
        "drift_field": item.drift_field,
        "drift_type": item.drift_type,
        "sample_value": item.sample_value,
    }


def _build_webhook_payload(
    delivery: AlertDelivery,
    *,
    destination: AlertDestination,
    rule: AlertRule,
    scan_name: str,
    project: Project | None,
    message: str,
) -> dict[str, object]:
    """Structured JSON body so downstream automation (Zapier/n8n/etc.) can parse
    individual fields without scraping the rendered ``message`` text."""
    return {
        "project": {
            "name": project.name if project else None,
            "slug": project.slug if project else None,
        },
        "destination": {"id": str(destination.id), "name": destination.name},
        "rule": {"id": str(rule.id), "name": rule.name},
        "scan": {"id": str(delivery.scan_config_id), "name": scan_name},
        "matched_count": delivery.matched_count,
        "message": message,
        "items": [_webhook_item_payload(item) for item in delivery.items],
    }


def _build_plan_digest_message(
    session: Session,
    *,
    project: Project,
    now: datetime,
) -> str:
    window_from = now - timedelta(days=DIGEST_WINDOW_DAYS)
    dead_cutoff = now - timedelta(days=DEAD_EVENT_DAYS)

    schema_drifts = session.execute(
        select(func.count(SchemaDrift.id))
        .join(EventType, EventType.id == SchemaDrift.event_type_id)
        .where(
            EventType.project_id == project.id,
            SchemaDrift.detected_at >= window_from,
            SchemaDrift.status.in_(("open", "snoozed")),
            (SchemaDrift.status != "snoozed")
            | (SchemaDrift.snoozed_until.is_(None))
            | (SchemaDrift.snoozed_until <= now),
        )
    ).scalar_one()
    metric_anomalies = session.execute(
        select(func.count(MetricAnomaly.id))
        .join(ScanConfig, ScanConfig.id == MetricAnomaly.scan_config_id)
        .where(ScanConfig.project_id == project.id, MetricAnomaly.created_at >= window_from)
    ).scalar_one()
    distribution_drifts = session.execute(
        select(func.count(DistributionDrift.id))
        .join(ScanConfig, ScanConfig.id == DistributionDrift.scan_config_id)
        .where(
            ScanConfig.project_id == project.id,
            DistributionDrift.bucket >= window_from,
            DistributionDrift.band == "significant",
        )
    ).scalar_one()
    total_events = session.execute(
        select(func.count(Event.id)).where(
            Event.project_id == project.id,
            Event.status != "archived",
        )
    ).scalar_one()
    live_events = session.execute(
        select(func.count(Event.id)).where(
            Event.project_id == project.id,
            Event.status != "archived",
            Event.last_seen_at.is_not(None),
        )
    ).scalar_one()
    dead_events = session.execute(
        select(func.count(Event.id)).where(
            Event.project_id == project.id,
            Event.status != "archived",
            Event.status.in_(["implemented", "live"]),
            (Event.last_seen_at.is_(None)) | (Event.last_seen_at < dead_cutoff),
        )
    ).scalar_one()
    sunset_overdue = session.execute(
        select(func.count(Event.id)).where(
            Event.project_id == project.id,
            Event.status == EventStatus.deprecated,
            Event.sunset_at.is_not(None),
            Event.sunset_at < now,
            Event.last_seen_at.is_not(None),
            Event.last_seen_at > Event.sunset_at,
        )
    ).scalar_one()

    top_rows = session.execute(
        select(MetricAnomaly, ScanConfig.name)
        .join(ScanConfig, ScanConfig.id == MetricAnomaly.scan_config_id)
        .where(ScanConfig.project_id == project.id, MetricAnomaly.created_at >= window_from)
        .order_by(MetricAnomaly.bucket.desc(), func.abs(MetricAnomaly.z_score).desc())
        .limit(5)
    ).all()
    top_lines = []
    for anomaly, scan_name in top_rows:
        top_lines.append(
            f"- {scan_name} {anomaly.scope_type}:{anomaly.scope_ref} "
            f"{anomaly.direction} actual={anomaly.actual_count} "
            f"expected={anomaly.expected_count:.1f} z={anomaly.z_score:.1f}"
        )

    coverage = (live_events / total_events * 100) if total_events else 0.0
    lines = [
        f"Weekly tripl digest for {project.name}",
        f"Window: last {DIGEST_WINDOW_DAYS} days",
        "",
        f"- Active schema drifts: {schema_drifts}",
        f"- Metric anomalies: {metric_anomalies}",
        f"- Significant distribution drifts: {distribution_drifts}",
        f"- Live coverage: {live_events}/{total_events} events ({coverage:.1f}%)",
        f"- Dead implemented events: {dead_events}",
        f"- Deprecated events still receiving data: {sunset_overdue}",
    ]
    if top_lines:
        lines.extend(["", "Top anomalies:", *top_lines])
    return "\n".join(lines)


def _build_sunset_alert_message(
    session: Session,
    *,
    project: Project,
    now: datetime,
) -> str | None:
    """Return a plaintext alert message when deprecated events are still
    receiving data past their sunset_at, or None when there are none."""
    overdue_events = session.execute(
        select(Event.id, Event.name, Event.sunset_at, Event.last_seen_at)
        .where(
            Event.project_id == project.id,
            Event.status == EventStatus.deprecated,
            Event.sunset_at.is_not(None),
            Event.sunset_at < now,
            Event.last_seen_at.is_not(None),
            Event.last_seen_at > Event.sunset_at,
        )
        .order_by(Event.name)
    ).all()

    if not overdue_events:
        return None

    lines = [
        f"Deprecated events still receiving data after sunset — {project.name}",
        f"Count: {len(overdue_events)}",
        "",
    ]
    for _eid, name, sunset_at, last_seen_at in overdue_events:
        lines.append(f"- {name} (sunset {sunset_at:%Y-%m-%d}, last seen {last_seen_at:%Y-%m-%d})")
    return "\n".join(lines)
