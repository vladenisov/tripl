"""Message-building helpers for alert deliveries.

Pure rendering/formatting logic extracted from alerts.py so that module stays
under a manageable size.  Nothing here touches Celery or outbound HTTP — all
I/O lives in alerts.py.
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tripl.alert_templates import (
    ALERT_MESSAGE_FORMAT_PLAIN,
    AlertTemplateContext,
    escape_alert_value,
    format_metric_alert_value,
    format_percent_delta,
    get_default_items_template,
    get_default_message_template,
    normalize_message_template,
    render_alert_template,
)
from tripl.alerting_matching import (
    SCOPE_METRIC,
    SCOPE_RELEASE_REGRESSION,
    SCOPE_VARIABLE_VALUE_DRIFT,
)
from tripl.anomaly_context import build_alert_item_context
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event, EventStatus
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift
from tripl.services import app_settings_service, llm_service

logger = logging.getLogger(__name__)

DIGEST_WINDOW_DAYS = 7
DEAD_EVENT_DAYS = 30

_AI_EXPLANATION_MAX_ITEMS = 10
_AI_EXPLANATION_MAX_TOKENS = 250

# How much of what this rule already said about these same scopes goes into the
# prompt. The explanation used to be a pure function of the current bucket, so
# an event drifting for the third day running produced the same paragraph three
# times and the reader learned nothing from the repeat (tripl-ikee).
_AI_HISTORY_MAX_DELIVERIES = 3
_AI_HISTORY_WINDOW = timedelta(days=7)
# Prior explanations are 2-4 sentences; keep a readable head of each so three of
# them cannot crowd out the current items.
_AI_HISTORY_EXPLANATION_CHARS = 320

# Telegram's sendMessage rejects a body over 4096 characters with HTTP 400
# "Bad Request: message is too long".
#
# The ceiling is on rendered LENGTH, not item count. Across the 29 deliveries
# this instance has sent (48 rendered items), a single item runs 97-389
# characters depending on how many of the optional
# drift/details/monitoring/movers/trend lines it carries — a 4x spread, so any
# item count safe for a schema-drift rule overshoots for an event rule carrying
# URLs. At the measured 355-character mean the items alone pass 4096 at 12
# items, and the whole message passes it at 10.
TELEGRAM_MESSAGE_MAX_CHARS = 4096


def telegram_message_length(text: str) -> int:
    """Length of ``text`` the way Telegram counts it.

    The 4096 ceiling is counted in UTF-16 code units — the same units the API
    uses for entity offsets — while ``len`` counts code points. Every character
    outside the BMP (emoji, and the symbols an event name can carry) therefore
    costs two where ``len`` charges one, so a body of 4000 code points can be
    refused at 4400 units. Budgeting in ``len`` is how the previous attempt at
    this ceiling let an oversized message through.
    """
    return len(text.encode("utf-16-le")) // 2


def _resolve_metric_units(
    session: Session | None,
    items: list[AlertDeliveryItem],
    cache: dict[str, str | None] | None,
) -> dict[str, str | None]:
    """Unit per metric-definition id for the delivery's metric-scope items.

    One batched query for all unresolved scope_refs; results land in ``cache``
    (when provided) so a re-render without a session — e.g. the MarkdownV2 →
    plain fallback — reuses them instead of losing the percent formatting.
    """
    units = cache if cache is not None else {}
    if session is None:
        return units
    missing = {
        item.scope_ref
        for item in items
        if item.scope_type == SCOPE_METRIC and item.scope_ref not in units
    }
    if not missing:
        return units
    metric_ids: list[uuid.UUID] = []
    for scope_ref in missing:
        try:
            metric_ids.append(uuid.UUID(scope_ref))
        except ValueError:
            units[scope_ref] = None
    if metric_ids:
        for metric_id, unit in session.execute(
            select(MetricDefinition.id, MetricDefinition.unit).where(
                MetricDefinition.id.in_(metric_ids)
            )
        ).all():
            units[str(metric_id)] = unit
    for scope_ref in missing:
        units.setdefault(scope_ref, None)
    return units


# The parenthetical that rides on ${expected_count} for the one scope whose
# expectation is not a plain baseline. See DEFAULT_ALERT_ITEMS_TEMPLATES.
_ADOPTION_ADJUSTED_LABEL = " (adoption-adjusted)"

_RELEASE_KIND_LABELS = {"missing": "disappeared", "volume_drop": "dropped"}


def _plain_number(value: float) -> str:
    """Stringify a number exactly as ``${expected_count}`` does, unescaped.

    The basis clause is escaped as a whole by its caller, so escaping here too
    would double-escape it under MarkdownV2. The plain format is the shared
    stringifier's pass-through branch, which is all this needs.
    """
    return escape_alert_value(value, ALERT_MESSAGE_FORMAT_PLAIN)


def _release_scope_noun(item: AlertDeliveryItem) -> str:
    """What the regressed scope IS, so the basis sentence can name it."""
    if item.event_id is not None:
        return "event"
    if item.event_type_id is not None:
        return "event type"
    return "scope"


def _format_window_span(item: AlertDeliveryItem) -> str | None:
    """``"51h"`` for the window this item was measured over, or None.

    ``bucket`` is the window's end and ``window_from`` its start. Items
    delivered before window_from existed, and every scope whose window IS its
    bucket, get None and simply lose the clause.
    """
    if item.window_from is None or item.bucket is None:
        return None
    hours = round((item.bucket - item.window_from).total_seconds() / 3600)
    if hours < 1:
        return None
    return f"{hours}h"


def _release_regression_basis(item: AlertDeliveryItem) -> str:
    """The body of the "release:" line: which build, over what window, vs what.

    Naming the build is not enough. ``expected`` for a release regression is
    ``total_new * share_prev`` — the PREVIOUS release's share of this scope
    applied to the NEW release's own volume over the rollout-overlap window —
    so it is not a count of the same thing as ``actual`` and the ``%`` beside
    it is already ``1 - share_new/share_prev``, i.e. the share-for-share drop.
    Printed bare, the pair reads as "the count halved", and the first reply is
    "so what, the release only just rolled out" — an objection the
    normalization has already priced in, because a smaller adopting cohort
    shrinks ``total_new`` and shrinks ``expected`` with it.

    So the line states that the expectation was built FROM the new release's
    own volume. That single fact is what kills the misreading; the window is
    corroboration. Costs ~117 UTF-16 units over the old line, well inside the
    per-item budget that keeps a full 8-item Telegram delivery in one message.
    """
    kind_label = _RELEASE_KIND_LABELS.get(item.drift_type or "", "regressed")
    version = item.drift_field or "the new release"
    previous = item.sample_value or "the previous release"
    span = _format_window_span(item)
    window_clause = f" over the {span} rollout overlap" if span else ""
    line = f"{kind_label} in {version} vs {previous}{window_clause}"
    if item.expected_count <= 0:
        # No baseline: there is no ratio to explain and ${percent_delta_label}
        # already says "no baseline". Adding the formula here would quote a
        # zero as if it were an expectation.
        return line
    return (
        f"{line}; {_plain_number(item.expected_count)} is {previous}'s share "
        f"of this {_release_scope_noun(item)} at {version}'s own volume, so "
        f"{format_percent_delta(item.percent_delta, item.expected_count)} "
        f"is share-for-share"
    )


def _build_item_template_context(
    item: AlertDeliveryItem,
    *,
    message_format: str,
    session: Session | None = None,
    scan_config_id: uuid.UUID | None = None,
    item_context_cache: dict[uuid.UUID, tuple[str, str]] | None = None,
    metric_unit: str | None = None,
) -> AlertTemplateContext:
    scope_label = {
        "project_total": "Project total",
        "event_type": "Event type",
        "event": "Event",
        "schema": "Schema drift",
        "distribution": "Distribution drift",
        SCOPE_RELEASE_REGRESSION: "Release regression",
    }.get(item.scope_type, item.scope_type)
    # An event's catalog entry and its charts are one page: `/events/detail/<id>`
    # redirects to `/monitoring/event/<id>`, and that view carries the field
    # values, meta fields AND the charts. So for event-scoped rows both builders
    # produce the same URL, and printing it twice under two labels made every
    # item look like it offered a choice it did not. The two still differ for
    # event-type and project-total scopes — monitoring points at the scope's own
    # page, details at the underlying event — so the lines collapse only when
    # they genuinely coincide. Both template variables stay populated either way,
    # so custom templates referencing ${monitoring_url} are unaffected.
    details_line = f"\n  details: {item.details_path}" if item.details_path else ""
    monitoring_line = (
        f"\n  monitoring: {item.monitoring_path}"
        if item.monitoring_path and item.monitoring_path != item.details_path
        else ""
    )
    if item.scope_type == SCOPE_RELEASE_REGRESSION:
        # Release regressions reuse the drift fields: version -> drift_field,
        # kind -> drift_type, previous release -> sample_value. Render them as a
        # readable "release:" line via the shared ${drift_line} placeholder.
        drift_line = f"\n  release: {_release_regression_basis(item)}"
    elif item.scope_type == SCOPE_VARIABLE_VALUE_DRIFT:
        # Value drift rides the shared fields: variable -> drift_field, sampled
        # novel values -> sample_value.
        observed_clause = f" observed {item.sample_value}" if item.sample_value else ""
        drift_line = f"\n  value drift: ${{{item.drift_field}}}{observed_clause}"
    else:
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
        # Percent-unit catalog metrics render stored fractions ×100 with a "%"
        # suffix; every other unit/scope passes the raw float through to the
        # shared stringifier unchanged. percent_delta stays a relative change.
        "actual_count": escape_alert_value(
            format_metric_alert_value(item.actual_count, metric_unit), message_format
        ),
        "expected_count": escape_alert_value(
            format_metric_alert_value(item.expected_count, metric_unit), message_format
        ),
        # Sits ON the number a reader would otherwise take for a raw count, so
        # the qualification arrives before the misreading rather than a line
        # after it. Empty for every scope whose expectation IS a baseline.
        "expected_basis": escape_alert_value(
            _ADOPTION_ADJUSTED_LABEL
            if item.scope_type == SCOPE_RELEASE_REGRESSION and item.expected_count > 0
            else "",
            message_format,
        ),
        "absolute_delta": escape_alert_value(
            format_metric_alert_value(item.absolute_delta, metric_unit), message_format
        ),
        "percent_delta": escape_alert_value(f"{item.percent_delta:.1f}", message_format),
        "percent_delta_label": escape_alert_value(
            format_percent_delta(item.percent_delta, item.expected_count), message_format
        ),
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
    metric_units_cache: dict[str, str | None] | None = None,
) -> str:
    """Render every item it is given, whole.

    Deliberately has no length budget of its own. It used to stop at the first
    item that would not fit and append a "+N more of 14 not shown" tail, which
    dropped matched scopes that the success path then stamped as notified. What
    a channel with a per-message ceiling does instead is carry fewer items per
    message and send more messages — see :func:`split_telegram_messages`, which
    chooses the subsets and hands them here one group at a time.
    """
    metric_units = _resolve_metric_units(session, items, metric_units_cache)
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
                metric_unit=(
                    metric_units.get(item.scope_ref) if item.scope_type == SCOPE_METRIC else None
                ),
            ),
        ).rstrip()
        if not rendered_item:
            continue
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
    metric_units_cache: dict[str, str | None] | None = None,
    items: list[AlertDeliveryItem] | None = None,
) -> AlertTemplateContext:
    message_format = message_format_override or rule.message_format or ALERT_MESSAGE_FORMAT_PLAIN
    items_template = normalize_message_template(rule.items_template)
    if items_template is None:
        items_template = get_default_items_template(message_format)
    # ``items`` is one message's share of a delivery split across several (see
    # split_telegram_messages). Its count, not the delivery's, is what the
    # header may claim: a reader looking at message 2 of 2 counts what is in
    # front of them, and the dispatch-side chunking already gives each of its
    # chunks its own matched_count for the same reason.
    rendered_items = delivery.items if items is None else items
    rendered_count = delivery.matched_count if items is None else len(items)

    variables = {
        "project_name": escape_alert_value(project.name if project else "", message_format),
        "project_slug": escape_alert_value(project.slug if project else "", message_format),
        "channel": escape_alert_value(destination.type, message_format),
        "destination_name": escape_alert_value(destination.name, message_format),
        "rule_name": escape_alert_value(rule.name, message_format),
        "scan_name": escape_alert_value(scan_name, message_format),
        "matched_count": escape_alert_value(rendered_count, message_format),
        "items_count": escape_alert_value(rendered_count, message_format),
        "items_text": _build_items_text(
            rendered_items,
            message_format=message_format,
            items_template=items_template,
            session=session,
            scan_config_id=delivery.scan_config_id,
            item_context_cache=item_context_cache,
            metric_units_cache=metric_units_cache,
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
    metric_units_cache: dict[str, str | None] | None = None,
    items: list[AlertDeliveryItem] | None = None,
) -> tuple[str, str]:
    """Render (message, message_format) for a delivery.

    ``items`` renders a subset — one message's share of a delivery split across
    several. None means the whole delivery, which is what every channel without
    a per-message ceiling gets.
    """
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
        metric_units_cache=metric_units_cache,
        items=items,
    )
    if template is None:
        template = get_default_message_template(context.message_format)
    return render_alert_template(template, context).rstrip(), context.message_format


def split_telegram_messages(
    delivery: AlertDelivery,
    *,
    destination: AlertDestination,
    rule: AlertRule,
    scan_name: str,
    project: Project | None,
    message: str,
    message_format: str,
    items: list[AlertDeliveryItem] | None = None,
    session: Session | None = None,
    item_context_cache: dict[uuid.UUID, tuple[str, str]] | None = None,
    metric_units_cache: dict[str, str | None] | None = None,
    ai_explanation: str | None = None,
    max_chars: int = TELEGRAM_MESSAGE_MAX_CHARS,
) -> list[tuple[str, list[AlertDeliveryItem]]]:
    """``message`` as one or more messages that each clear Telegram's ceiling.

    Returns (text, the items that text carries) in send order, so the caller
    knows exactly what has gone out if a later message fails.

    ``message`` is the already-rendered whole — the caller needs it anyway for
    the payload snapshot — so the common case costs one length check and no
    re-render at all. Only when it does not fit are the items packed greedily
    into messages, each one measured as the reader will receive it: header,
    items and AI note assembled and counted in Telegram's UTF-16 units. That is
    what the reserve-based budget it replaces could only estimate — the header
    comes from a user-editable template and the AI note from a language model,
    so both could exceed their reserve and no items budget could see it.

    The AI note rides on the first message only. It summarises the whole
    delivery, and repeating it under every part would cost the reader nothing
    but length.

    Nothing is ever dropped: an item too long to share a message gets one of its
    own. A SINGLE item that alone exceeds the ceiling is the one thing this
    cannot fix — it is returned as its own message and Telegram refuses it, so
    the delivery fails visibly instead of quietly losing the item.
    """
    delivery_items = delivery.items if items is None else items
    if len(delivery_items) <= 1 or telegram_message_length(message) <= max_chars:
        return [(message, list(delivery_items))]

    def render_part(part: list[AlertDeliveryItem], *, with_ai_note: bool) -> str:
        text, part_format = _render_delivery_message(
            delivery,
            destination=destination,
            rule=rule,
            scan_name=scan_name,
            project=project,
            message_format_override=message_format,
            session=session,
            item_context_cache=item_context_cache,
            metric_units_cache=metric_units_cache,
            items=part,
        )
        if with_ai_note and ai_explanation:
            text = _append_ai_explanation(text, ai_explanation, part_format)
        return text

    parts: list[tuple[str, list[AlertDeliveryItem]]] = []
    current: list[AlertDeliveryItem] = []
    current_text = ""
    for item in delivery_items:
        candidate = [*current, item]
        candidate_text = render_part(candidate, with_ai_note=not parts)
        # ``current`` being non-empty is what keeps a lone oversized item in:
        # closing an empty message to make room for it would drop it forever.
        if current and telegram_message_length(candidate_text) > max_chars:
            parts.append((current_text, current))
            current = [item]
            current_text = render_part(current, with_ai_note=False)
            continue
        current = candidate
        current_text = candidate_text
    parts.append((current_text, current))
    return parts


def _describe_age(delta: timedelta) -> str:
    minutes = int(delta.total_seconds() // 60)
    if minutes < 60:
        return f"{max(minutes, 1)}m ago"
    hours = minutes // 60
    if hours < 48:
        return f"{hours}h ago"
    return f"{hours // 24}d ago"


def _recent_alert_history(
    session: Session,
    delivery: AlertDelivery,
    *,
    now: datetime,
) -> list[str]:
    """What this rule already told the reader about these same scopes.

    Matching is by ``scope_ref`` rather than the whole rule: a rule covering a
    hundred events would otherwise drag in unrelated history and the model would
    "recall" something the reader never saw about this event. Only ``sent``
    deliveries count — a failed one was never read, so claiming to have reported
    it would be a lie.

    Returns newest-first prose lines; an empty list simply leaves the prompt as
    it was, which is the correct behaviour for a genuinely first-time alert.
    """
    scope_refs = {item.scope_ref for item in delivery.items if item.scope_ref}
    if not scope_refs:
        return []

    matching_items = (
        select(AlertDeliveryItem.delivery_id)
        .where(
            AlertDeliveryItem.delivery_id == AlertDelivery.id,
            AlertDeliveryItem.scope_ref.in_(scope_refs),
        )
        .exists()
    )
    previous = (
        session.execute(
            select(AlertDelivery)
            .where(
                AlertDelivery.rule_id == delivery.rule_id,
                AlertDelivery.id != delivery.id,
                AlertDelivery.status == AlertDeliveryStatus.sent.value,
                AlertDelivery.sent_at.is_not(None),
                AlertDelivery.sent_at >= now - _AI_HISTORY_WINDOW,
                matching_items,
            )
            .order_by(AlertDelivery.sent_at.desc())
            .limit(_AI_HISTORY_MAX_DELIVERIES)
        )
        .scalars()
        .all()
    )

    lines: list[str] = []
    for past in previous:
        sent_at = past.sent_at
        if sent_at is None:
            continue
        # SQLite hands back naive datetimes where PostgreSQL is tz-aware; the
        # subtraction below would raise on the mix.
        if sent_at.tzinfo is None:
            sent_at = sent_at.replace(tzinfo=UTC)
        snapshot = past.payload_snapshot if isinstance(past.payload_snapshot, dict) else {}
        said = str(snapshot.get("ai_explanation") or "").strip()
        scopes = ", ".join(sorted({item.scope_name for item in past.items if item.scope_name})[:4])
        line = f"- {_describe_age(now - sent_at)} ({sent_at:%Y-%m-%d %H:%M} UTC)"
        if scopes:
            line += f", about {scopes}"
        if said:
            head = said[:_AI_HISTORY_EXPLANATION_CHARS]
            if len(said) > _AI_HISTORY_EXPLANATION_CHARS:
                head += "…"
            line += f'. You already told them: "{head}"'
        else:
            line += ". (no AI note was attached that time)"
        lines.append(line)
    return lines


def _build_ai_explanation(
    delivery: AlertDelivery,
    *,
    scan_name: str,
    project_name: str,
    item_context_cache: dict[uuid.UUID, tuple[str, str]],
    session: Session | None = None,
    now: datetime | None = None,
) -> str | None:
    """LLM summary of the delivery's items, or None when AI is off or fails.

    Reuses the (sparkline, top_movers) pairs already built for template
    rendering — no extra DB queries. Failure here must never block the alert,
    so any error degrades to None.
    """
    ai_config = app_settings_service.get_ai_config_sync()
    lines: list[str] = [f"Project: {project_name}", f"Scan: {scan_name}", "Alert items:"]
    # The correlation id cannot answer "did this co-fire?". It is the inbox
    # handle, every item carries one, and it is keyed per SCOPE — so counting
    # group members finds exactly one member for every item and the tag would
    # silently never appear again. Peers are counted inside this delivery
    # instead, on the pair that makes co-firing mean something: one bucket, one
    # direction.
    cofiring_sizes: Counter[tuple[datetime, str]] = Counter(
        (item.bucket, item.direction) for item in delivery.items
    )
    for item in delivery.items[:_AI_EXPLANATION_MAX_ITEMS]:
        sparkline, top_movers = item_context_cache.get(item.id, ("", ""))
        if item.scope_type == SCOPE_RELEASE_REGRESSION:
            # Same basis clause as the rendered message. Without it the model
            # writes the note from "observed 345 vs expected 715.7" alone and
            # re-teaches the raw-count reading the message line just removed.
            lines.append(
                f"- [release regression] {item.scope_name}: "
                f"{_release_regression_basis(item)}; observed "
                f"{_plain_number(item.actual_count)} vs adoption-adjusted "
                f"expected {_plain_number(item.expected_count)}"
            )
            continue
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
        # "no baseline" rather than "+0%" for a zero-expected item: the note the
        # model writes from this prompt is what the reader receives, and "+0%"
        # reads as "nothing moved" for the one class where everything did
        # (tripl-l429.24).
        line = (
            f"- [{item.scope_type}] {item.scope_name}: {item.direction}, "
            f"actual {item.actual_count} vs expected {item.expected_count} "
            f"({format_percent_delta(item.percent_delta, item.expected_count, spec='+.0f')}), "
            f"bucket {item.bucket:%Y-%m-%d %H:%M}"
        )
        if sparkline:
            line += f", recent trend (old→new): {sparkline}"
        if top_movers:
            line += f", top movers: {top_movers}"
        if cofiring_sizes.get((item.bucket, item.direction), 0) > 1:
            line += " [co-fired with other items]"
        lines.append(line)
    # What was already said about these scopes, so a recurring drift reads as
    # "still going, now worse" instead of the same paragraph again (tripl-ikee).
    # Best-effort: a history lookup must never cost the reader their alert.
    if session is not None:
        try:
            history = _recent_alert_history(session, delivery, now=now or datetime.now(UTC))
        except Exception:  # noqa: BLE001
            logger.warning("Alert history lookup for the AI explanation failed", exc_info=True)
            history = []
        if history:
            lines.append("")
            lines.append(
                "Previously sent by this rule for these same scopes (most recent first). "
                "Say what has CHANGED since; do not repeat what the reader already read:"
            )
            lines.extend(history)
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


def _is_telegram_message_too_long_error(error: Exception) -> bool:
    """True for Telegram's over-4096 rejection.

    ``_post_json`` turns the HTTPError into ValueError("HTTP 400 from <url>:
    Bad Request: message is too long"), which
    :func:`_is_telegram_markdown_parse_error` correctly does not match — it is
    not a parse failure, and re-rendering as plain text makes a long message
    longer, not shorter.

    Since :func:`split_telegram_messages` measures each message as Telegram
    counts it, this can now only mean one alert item is longer than 4096 units
    on its own — nothing a smaller budget could fix. It is matched so the
    sender can say that in the delivery's error, instead of leaving the raw
    HTTP 400 in the Inbox.
    """
    return "message is too long" in str(error).lower()


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

    # Event counts are scoped to the MAIN plan branch, mirroring the API read
    # paths (resolve_branch_id): an open working branch deep-copies every event
    # row, so an unscoped count reports each event once per branch.
    main_branch_id = session.scalar(
        select(PlanBranch.id).where(
            PlanBranch.project_id == project.id,
            PlanBranch.kind == BranchKind.main.value,
        )
    )

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
            Event.branch_id == main_branch_id,
            Event.status != "archived",
        )
    ).scalar_one()
    live_events = session.execute(
        select(func.count(Event.id)).where(
            Event.project_id == project.id,
            Event.branch_id == main_branch_id,
            Event.status != "archived",
            Event.last_seen_at.is_not(None),
        )
    ).scalar_one()
    dead_events = session.execute(
        select(func.count(Event.id)).where(
            Event.project_id == project.id,
            Event.branch_id == main_branch_id,
            Event.status != "archived",
            Event.status.in_(["implemented", "live"]),
            (Event.last_seen_at.is_(None)) | (Event.last_seen_at < dead_cutoff),
        )
    ).scalar_one()
    sunset_overdue = session.execute(
        select(func.count(Event.id)).where(
            Event.project_id == project.id,
            Event.branch_id == main_branch_id,
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
