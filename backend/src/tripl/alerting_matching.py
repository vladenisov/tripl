"""Pure rule/anomaly matching helpers shared by live and simulated paths.

The live alert pipeline (worker/tasks/metrics.py) and the in-UI rule simulator
both apply the SAME predicates to anomalies — extracting them here guarantees
the simulator never diverges from production behavior.

These functions never touch the session and never mutate state.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_filter import AlertRuleFilter
from tripl.models.metric_anomaly import MetricAnomaly


def filter_matches_anomaly(filter_row: AlertRuleFilter, anomaly: MetricAnomaly) -> bool:
    if filter_row.field == "event_type":
        actual = str(anomaly.event_type_id) if anomaly.event_type_id is not None else None
    elif filter_row.field == "event":
        actual = str(anomaly.event_id) if anomaly.event_id is not None else None
    elif filter_row.field == "direction":
        actual = "up" if anomaly.direction == "spike" else "down"
    else:
        return True

    if actual is None:
        return True

    values = set(filter_row.values or [])
    if filter_row.operator in ("eq", "in"):
        return actual in values
    if filter_row.operator in ("ne", "not_in"):
        return actual not in values
    return True


def rule_matches_anomaly(rule: AlertRule, anomaly: MetricAnomaly) -> bool:
    # Scope gates.
    if anomaly.scope_type == "project_total" and not rule.include_project_total:
        return False
    if anomaly.scope_type == "event_type" and not rule.include_event_types:
        return False
    if anomaly.scope_type == "event" and not rule.include_events:
        return False

    # Direction gates.
    if anomaly.direction == "spike" and not rule.notify_on_spike:
        return False
    if anomaly.direction == "drop" and not rule.notify_on_drop:
        return False

    # Numeric thresholds.
    if anomaly.expected_count < rule.min_expected_count:
        return False
    absolute_delta = abs(anomaly.actual_count - anomaly.expected_count)
    if absolute_delta < rule.min_absolute_delta:
        return False
    if anomaly.expected_count > 0:
        percent_delta = absolute_delta / anomaly.expected_count * 100
    else:
        percent_delta = 0.0
    if percent_delta < rule.min_percent_delta:
        return False

    return all(filter_matches_anomaly(filter_row, anomaly) for filter_row in rule.filters)


def simulate_rule_firings(
    rule: AlertRule,
    anomalies: list[MetricAnomaly],
) -> list[MetricAnomaly]:
    """Replay anomalies through a rule with in-memory cooldown gating.

    Returns the subset that would have triggered a delivery, in bucket order.
    Cooldown is applied per (scope_type, scope_ref) — the same partition the
    live pipeline uses for AlertRuleState.
    """
    if rule.cooldown_minutes < 0:
        cooldown = timedelta(0)
    else:
        cooldown = timedelta(minutes=rule.cooldown_minutes)

    fired: list[MetricAnomaly] = []
    last_fired_at: dict[tuple[str, str], datetime] = {}

    for anomaly in sorted(anomalies, key=lambda a: a.bucket):
        if not rule_matches_anomaly(rule, anomaly):
            continue
        key = (anomaly.scope_type, anomaly.scope_ref)
        last = last_fired_at.get(key)
        if last is not None and anomaly.bucket - last < cooldown:
            continue
        fired.append(anomaly)
        last_fired_at[key] = anomaly.bucket

    return fired
