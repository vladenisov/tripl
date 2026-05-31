from __future__ import annotations

from tripl.alert_templates import (
    ALERT_MESSAGE_FORMAT_PLAIN,
    AlertTemplateContext,
    escape_alert_value,
    get_default_items_template,
    get_default_message_template,
    normalize_message_template,
    render_alert_template,
)
from tripl.alerting_matching import SCOPE_DISTRIBUTION_DRIFT
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.project import Project
from tripl.schemas.alerting import SimulatedRuleFiring

SCOPE_SCHEMA_DRIFT = "schema"

_SCOPE_LABELS = {
    "project_total": "Project total",
    "event_type": "Event type",
    "event": "Event",
    SCOPE_SCHEMA_DRIFT: "Schema drift",
    SCOPE_DISTRIBUTION_DRIFT: "Distribution drift",
}


def render_firing_item(
    firing: SimulatedRuleFiring,
    *,
    message_format: str,
    items_template: str,
) -> str:
    """Render a single simulated firing through the rule's items_template.

    Mirrors the worker's _build_item_template_context — sparkline/top_movers
    are left empty because preview is sync-friendly and shouldn't burn extra
    queries per firing.
    """
    scope_label = _SCOPE_LABELS.get(firing.scope_type, firing.scope_type)
    drift_line = ""
    if firing.drift_field and firing.drift_type:
        drift_summary = f"{firing.drift_type}: {firing.drift_field}"
        if firing.sample_value:
            drift_summary += f" — e.g. {firing.sample_value}"
        drift_line = f"\n  drift: {drift_summary}"

    variables = {
        "scope_name": escape_alert_value(firing.scope_name, message_format),
        "scope_type": escape_alert_value(firing.scope_type, message_format),
        "scope_label": escape_alert_value(scope_label, message_format),
        "direction": escape_alert_value(firing.direction, message_format),
        "direction_label": escape_alert_value(
            "up" if firing.direction == "spike" else "down",
            message_format,
        ),
        "actual_count": escape_alert_value(firing.actual_count, message_format),
        "expected_count": escape_alert_value(int(round(firing.expected_count)), message_format),
        "absolute_delta": escape_alert_value(int(round(firing.absolute_delta)), message_format),
        "percent_delta": escape_alert_value(f"{firing.percent_delta:.1f}", message_format),
        "bucket": escape_alert_value(firing.bucket, message_format),
        "details_url": "",
        "monitoring_url": "",
        "details_line": "",
        "monitoring_line": "",
        "drift_field": escape_alert_value(firing.drift_field or "", message_format),
        "drift_type": escape_alert_value(firing.drift_type or "", message_format),
        "sample_value": escape_alert_value(firing.sample_value or "", message_format),
        "drift_line": escape_alert_value(drift_line, message_format),
        "sparkline": "",
        "top_movers": "",
        "sparkline_line": "",
        "top_movers_line": "",
    }
    return render_alert_template(
        items_template,
        AlertTemplateContext(variables=variables, message_format=message_format),
    ).rstrip()


def render_firings_message(
    rule: AlertRule,
    firings: list[SimulatedRuleFiring],
    *,
    destination: AlertDestination,
    project: Project,
) -> tuple[list[str], str]:
    """Render per-firing items + the overall message text for the preview."""
    message_format = rule.message_format or ALERT_MESSAGE_FORMAT_PLAIN
    items_template = normalize_message_template(rule.items_template) or get_default_items_template(
        message_format
    )
    rendered_items = [
        render_firing_item(firing, message_format=message_format, items_template=items_template)
        for firing in firings
    ]
    items_text = "\n".join(item for item in rendered_items if item)

    message_template = normalize_message_template(
        rule.message_template
    ) or get_default_message_template(message_format)
    overall_variables = {
        "project_name": escape_alert_value(project.name, message_format),
        "project_slug": escape_alert_value(project.slug, message_format),
        "channel": escape_alert_value(destination.type, message_format),
        "destination_name": escape_alert_value(destination.name, message_format),
        "rule_name": escape_alert_value(rule.name, message_format),
        "scan_name": escape_alert_value("(replay)", message_format),
        "matched_count": escape_alert_value(len(firings), message_format),
        "items_count": escape_alert_value(len(firings), message_format),
        "items_text": items_text,
    }
    rendered_message = render_alert_template(
        message_template,
        AlertTemplateContext(variables=overall_variables, message_format=message_format),
    ).rstrip()
    return rendered_items, rendered_message


def trim_alert_text(value: str | None, *, max_length: int = 500) -> str | None:
    if value is None or len(value) <= max_length:
        return value
    return value[: max_length - 3] + "..."


def format_distribution_drift_sample(drift: DistributionDrift) -> str:
    parts = [f"psi={drift.psi:.3f}"]
    mover_parts: list[str] = []
    for mover in (drift.top_movers or [])[:3]:
        value = str(mover.get("value", ""))
        baseline_share = _mover_float(mover.get("baseline_share")) * 100
        current_share = _mover_float(mover.get("current_share")) * 100
        mover_parts.append(f"{value} {baseline_share:.1f}%->{current_share:.1f}%")
    if mover_parts:
        parts.append(", ".join(mover_parts))
    return trim_alert_text("; ".join(parts)) or ""


def _mover_float(value: object) -> float:
    if isinstance(value, (int, float, str)):
        return float(value)
    return 0.0
