from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import datetime

from tripl.models.alert_destination import AlertDestinationType
from tripl.models.domain_enums import AlertMessageFormat

ALERT_MESSAGE_FORMAT_PLAIN = AlertMessageFormat.plain.value
ALERT_MESSAGE_FORMAT_SLACK_MRKDWN = AlertMessageFormat.slack_mrkdwn.value
ALERT_MESSAGE_FORMAT_TELEGRAM_HTML = AlertMessageFormat.telegram_html.value
ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2 = AlertMessageFormat.telegram_markdownv2.value

ALERT_MESSAGE_FORMATS_BY_DESTINATION: dict[str, tuple[str, ...]] = {
    AlertDestinationType.slack: (
        ALERT_MESSAGE_FORMAT_PLAIN,
        ALERT_MESSAGE_FORMAT_SLACK_MRKDWN,
    ),
    AlertDestinationType.telegram: (
        ALERT_MESSAGE_FORMAT_PLAIN,
        ALERT_MESSAGE_FORMAT_TELEGRAM_HTML,
        ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2,
    ),
}

DEFAULT_ALERT_MESSAGE_TEMPLATES: dict[str, str] = {
    ALERT_MESSAGE_FORMAT_PLAIN: (
        "[tripl] ${matched_count} alerts\n"
        "Project delivery via ${channel}: ${destination_name}\n"
        "Rule: ${rule_name}\n"
        "Scan: ${scan_name}\n\n"
        "${items_text}"
    ),
    ALERT_MESSAGE_FORMAT_SLACK_MRKDWN: (
        "*[tripl] ${matched_count} alerts*\n"
        "Project delivery via ${channel}: ${destination_name}\n"
        "Rule: *${rule_name}*\n"
        "Scan: `${scan_name}`\n\n"
        "${items_text}"
    ),
    ALERT_MESSAGE_FORMAT_TELEGRAM_HTML: (
        "<b>[tripl] ${matched_count} alerts</b>\n"
        "Project delivery via ${channel}: ${destination_name}\n"
        "Rule: <b>${rule_name}</b>\n"
        "Scan: <code>${scan_name}</code>\n\n"
        "${items_text}"
    ),
    ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2: (
        "*tripl: ${matched_count} alerts*\n"
        "Project delivery via ${channel}: ${destination_name}\n"
        "Rule: *${rule_name}*\n"
        "Scan: `${scan_name}`\n\n"
        "${items_text}"
    ),
}

# ``${percent_delta_label}`` rather than a bare ``${percent_delta}%``: the label
# carries its own unit, so it can say "no baseline" where a percentage has
# nothing to divide by. For every item that HAS a baseline it renders exactly the
# text these templates produced before (see ``format_percent_delta``).
#
# ``${expected_basis}`` sits ON the expected number rather than a line below it.
# One scope computes ``expected`` differently from every other: a release
# regression's expectation is the PREVIOUS release's share of the scope applied
# to the NEW release's own volume, so it shrinks when adoption is low and the
# comparison is share-against-share. Printed bare next to ``actual``, it reads
# as a raw count of the same thing, and the first question a reader asks is
# "so what if it's lower, not everyone updated yet?" — an objection the
# normalization has already answered. The qualifier renders empty for every
# other scope, so nothing else moves.
DEFAULT_ALERT_ITEMS_TEMPLATES: dict[str, str] = {
    ALERT_MESSAGE_FORMAT_PLAIN: (
        "- ${scope_label} ${scope_name}: ${direction_label}, "
        "actual=${actual_count}, expected=${expected_count}${expected_basis}, "
        "delta=${absolute_delta} (${percent_delta_label})"
        "${drift_line}${details_line}${monitoring_line}${top_movers_line}${sparkline_line}"
    ),
    ALERT_MESSAGE_FORMAT_SLACK_MRKDWN: (
        "- ${scope_label} ${scope_name}: ${direction_label}, "
        "actual=${actual_count}, expected=${expected_count}${expected_basis}, "
        "delta=${absolute_delta} (${percent_delta_label})"
        "${drift_line}${details_line}${monitoring_line}${top_movers_line}${sparkline_line}"
    ),
    ALERT_MESSAGE_FORMAT_TELEGRAM_HTML: (
        "- ${scope_label} ${scope_name}: ${direction_label}, "
        "actual=${actual_count}, expected=${expected_count}${expected_basis}, "
        "delta=${absolute_delta} (${percent_delta_label})"
        "${drift_line}${details_line}${monitoring_line}${top_movers_line}${sparkline_line}"
    ),
    ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2: (
        "\\- ${scope_label} ${scope_name}: ${direction_label}, "
        "actual=${actual_count}, expected=${expected_count}${expected_basis}, "
        "delta=${absolute_delta} \\(${percent_delta_label}\\)"
        "${drift_line}${details_line}${monitoring_line}${top_movers_line}${sparkline_line}"
    ),
}

ALERT_TEMPLATE_VARIABLES: dict[str, str] = {
    "project_name": "Project display name",
    "project_slug": "Project slug",
    "channel": "Destination channel",
    "destination_name": "Destination name",
    "rule_name": "Rule name",
    "scan_name": "Scan config name",
    "matched_count": "Number of matched alert items",
    "items_count": "Alias for matched_count",
    "items_text": "Preformatted list of all matched alert items",
}

ALERT_ITEM_TEMPLATE_VARIABLES: dict[str, str] = {
    "scope_name": "Matched scope name",
    "scope_type": "Matched scope type",
    "scope_label": "Matched scope label",
    "direction": "Direction: spike or drop",
    "direction_label": "Direction: up or down",
    "actual_count": "Actual count",
    "expected_count": "Expected count",
    "expected_basis": (
        "How the expected count was derived, when it is not a plain baseline "
        '("(adoption-adjusted)" for release regressions; empty otherwise)'
    ),
    "absolute_delta": "Absolute delta",
    "percent_delta": "Percent delta as a bare number (0 when there was no baseline)",
    "percent_delta_label": 'Percent delta with its "%" sign, or "no baseline" when expected is 0',
    "bucket": "Anomaly bucket timestamp",
    "details_url": "Event details URL",
    "monitoring_url": "Monitoring URL",
    "details_line": "Rendered details line with leading newline when URL exists",
    "monitoring_line": "Rendered monitoring line with leading newline when URL exists",
    "drift_field": "Drift field name (empty for metric anomalies)",
    "drift_type": "Drift type (empty for metric anomalies)",
    "sample_value": "Drift sample value (empty when unavailable)",
    "drift_line": "Rendered drift line with leading newline when drift context exists",
    "sparkline": "ASCII sparkline of recent bucket counts (empty if no history)",
    "top_movers": "Inline summary of top-3 breakdown movers (empty if none)",
    "sparkline_line": "Rendered trend line with leading newline when sparkline exists",
    "top_movers_line": "Rendered movers line with leading newline when movers exist",
}

_ALERT_TEMPLATE_VAR_RE = re.compile(r"\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}")
_TELEGRAM_MARKDOWNV2_SPECIAL_CHARS = set("_*[]()~`>#+-=|{}.!\\")

# Catalog metric unit that marks stored-fraction values (0.08 == 8%).
METRIC_UNIT_PERCENT = "%"

# What the percent parenthetical says when there is nothing to divide by.
NO_BASELINE_LABEL = "no baseline"


@dataclass(frozen=True)
class AlertTemplateContext:
    variables: dict[str, str]
    message_format: str


def normalize_message_template(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def normalize_message_format(value: str | None) -> str:
    return value or ALERT_MESSAGE_FORMAT_PLAIN


def get_default_message_template(message_format: str | None) -> str:
    normalized_format = normalize_message_format(message_format)
    return DEFAULT_ALERT_MESSAGE_TEMPLATES.get(
        normalized_format,
        DEFAULT_ALERT_MESSAGE_TEMPLATES[ALERT_MESSAGE_FORMAT_PLAIN],
    )


def get_default_items_template(message_format: str | None) -> str:
    normalized_format = normalize_message_format(message_format)
    return DEFAULT_ALERT_ITEMS_TEMPLATES.get(
        normalized_format,
        DEFAULT_ALERT_ITEMS_TEMPLATES[ALERT_MESSAGE_FORMAT_PLAIN],
    )


def get_supported_message_formats(destination_type: str) -> tuple[str, ...]:
    return ALERT_MESSAGE_FORMATS_BY_DESTINATION.get(destination_type, (ALERT_MESSAGE_FORMAT_PLAIN,))


def validate_template_configuration(
    *,
    destination_type: str,
    message_format: str | None,
    message_template: str | None,
    items_template: str | None,
) -> tuple[str, str | None, str | None]:
    normalized_format = normalize_message_format(message_format)
    supported_formats = get_supported_message_formats(destination_type)
    if normalized_format not in supported_formats:
        raise ValueError(
            f"Message format {normalized_format!r} is not supported for {destination_type}"
        )

    normalized_template = normalize_message_template(message_template)
    if normalized_template is not None:
        unknown_variables = sorted(
            {
                match.group(1)
                for match in _ALERT_TEMPLATE_VAR_RE.finditer(normalized_template)
                if match.group(1) not in ALERT_TEMPLATE_VARIABLES
            }
        )
        if unknown_variables:
            raise ValueError("Unknown alert template variables: " + ", ".join(unknown_variables))

    normalized_items_template = normalize_message_template(items_template)
    if normalized_items_template is not None:
        unknown_item_variables = sorted(
            {
                match.group(1)
                for match in _ALERT_TEMPLATE_VAR_RE.finditer(normalized_items_template)
                if match.group(1) not in ALERT_ITEM_TEMPLATE_VARIABLES
            }
        )
        if unknown_item_variables:
            raise ValueError(
                "Unknown alert item template variables: " + ", ".join(unknown_item_variables)
            )

    return normalized_format, normalized_template, normalized_items_template


def escape_alert_value(value: object, message_format: str) -> str:
    text = _stringify_alert_value(value)
    if message_format == ALERT_MESSAGE_FORMAT_TELEGRAM_HTML:
        return html.escape(text, quote=True)
    if message_format == ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2:
        return "".join(
            f"\\{char}" if char in _TELEGRAM_MARKDOWNV2_SPECIAL_CHARS else char for char in text
        )
    if message_format == ALERT_MESSAGE_FORMAT_SLACK_MRKDWN:
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return text


def render_alert_template(template: str, context: AlertTemplateContext) -> str:
    return _ALERT_TEMPLATE_VAR_RE.sub(
        lambda match: context.variables.get(match.group(1), match.group(0)),
        template,
    )


def _stringify_alert_value(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, float):
        return f"{value:.1f}" if not value.is_integer() else str(int(value))
    return str(value)


def format_metric_alert_value(value: float, unit: str | None) -> str | float:
    """Percent-aware rendering for metric-scope alert values.

    Catalog metrics with unit ``%`` store fractions (0.08 == 8%), so scale by
    100 and suffix ``%`` using the same integral/fractional rules as the shared
    stringifier ("8%" integral, "8.3%" fractional). Any other unit returns the
    value unchanged so downstream stringifying/escaping behaves exactly as
    before. Rounding absorbs binary float noise (0.08 * 100 == 8.000...002).
    """
    if unit != METRIC_UNIT_PERCENT:
        return value
    scaled = round(float(value) * 100, 10)
    return f"{_stringify_alert_value(scaled)}%"


def format_percent_delta(percent_delta: float, expected_count: float, *, spec: str = ".1f") -> str:
    """The percent parenthetical for one alert item, unit included.

    The percent gate deliberately admits anomalies with no baseline at all
    (tripl-l429.12) — a scope resuming after an outage, an event firing for the
    first time, a schema drift, which all arrive with ``expected_count`` 0. The
    stored ``percent_delta`` is 0.0 for those, because the ratio is undefined and
    the column is NOT NULL; printing it reported the largest possible relative
    move as the smallest (tripl-l429.24). The absolute delta stands on its own
    for that class, and the default item templates already print it.

    ``expected_count > 0`` is the exact condition under which the stored number
    was computed (``dispatch._prepare_alert_deliveries``,
    ``alerting_service.simulate_rule``), so the label and the number can never
    disagree about whether there was a baseline. ``spec`` is the float format the
    caller wants around it: the item templates use ".1f", the AI prompt "+.0f".
    """
    if expected_count > 0:
        return f"{percent_delta:{spec}}%"
    return NO_BASELINE_LABEL
