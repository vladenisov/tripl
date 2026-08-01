"""Monitors, anomaly signals, alert deliveries and reconciliation health."""

from __future__ import annotations

from tripl_cli.api.request import ApiRequest

MONITORS_SUMMARY = "/projects/{slug}/monitors-summary"
SIGNALS = "/projects/{slug}/anomalies/signals"
ALERT_DELIVERIES = "/projects/{slug}/alert-deliveries"
COVERAGE = "/projects/{slug}/reconciliation/coverage"
DEAD_EVENTS = "/projects/{slug}/reconciliation/dead-events"
SHADOW_EVENTS = "/projects/{slug}/reconciliation/shadow-events"

ENDPOINTS: tuple[tuple[str, str], ...] = (
    ("get", MONITORS_SUMMARY),
    ("get", SIGNALS),
    ("get", ALERT_DELIVERIES),
    ("get", COVERAGE),
    ("get", DEAD_EVENTS),
    ("get", SHADOW_EVENTS),
)


def get_monitors_summary(slug: str) -> ApiRequest:
    return ApiRequest("GET", MONITORS_SUMMARY.format(slug=slug))


def list_signals(slug: str, *, expanded: bool | None = None) -> ApiRequest:
    """Anomaly signals. ``expanded=True`` is load-bearing for ``tripl watch``.

    The collapsed list appends SCOPE_EVENT only ``if event_ids or expanded``, so
    an incident made purely of event-scope anomalies would be dropped — precisely
    the incident a follow mode would be running for. The MCP's own summary tool
    leaves it unset deliberately; that is a context-budget choice, not an
    oversight, and the parameter is optional so both spellings stay honest.
    """
    return ApiRequest("GET", SIGNALS.format(slug=slug), params={"expanded": expanded})


def list_alert_deliveries(
    slug: str, *, status: str | None = None, limit: int | None = None
) -> ApiRequest:
    """Answers ``{items, total}``."""
    return ApiRequest(
        "GET", ALERT_DELIVERIES.format(slug=slug), params={"status": status, "limit": limit}
    )


def get_coverage(slug: str, *, days: int | None = None) -> ApiRequest:
    return ApiRequest("GET", COVERAGE.format(slug=slug), params={"days": days})


def list_dead_events(slug: str) -> ApiRequest:
    return ApiRequest("GET", DEAD_EVENTS.format(slug=slug))


def list_shadow_events(slug: str) -> ApiRequest:
    return ApiRequest("GET", SHADOW_EVENTS.format(slug=slug))
