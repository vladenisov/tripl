"""Pure rule/anomaly matching helpers shared by live and simulated paths.

The live alert pipeline (worker/tasks/metrics.py) and the in-UI rule simulator
both apply the SAME predicates to anomalies — extracting them here guarantees
the simulator never diverges from production behavior.

These functions never touch the session and never mutate state.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Protocol

from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_filter import AlertRuleFilter
from tripl.models.domain_enums import MetricScopeType

SCOPE_DISTRIBUTION_DRIFT = MetricScopeType.distribution.value
SCOPE_RELEASE_REGRESSION = MetricScopeType.release_regression.value
SCOPE_METRIC = MetricScopeType.metric.value
SCOPE_VARIABLE_VALUE_DRIFT = MetricScopeType.variable_value_drift.value


class AlertMatchCandidate(Protocol):
    id: uuid.UUID
    # The scan this signal came from, or NULL when it is project-global
    # (``metric`` scope). ``rule_matches_anomaly`` needs it to honour a
    # scan-bound rule, so EVERY candidate type has to carry it — the dataclass
    # ones below included, or a drift candidate would slip past the gate.
    scan_config_id: uuid.UUID | None
    scope_type: str
    scope_ref: str
    event_id: uuid.UUID | None
    event_type_id: uuid.UUID | None
    bucket: datetime
    direction: str
    # Float: fractional catalog metrics carry sub-unit actuals (tripl-68bc).
    actual_count: float
    expected_count: float


@dataclass
class DriftAlertCandidate:
    """Anomaly candidate carrying drift metadata (schema or distribution).

    Schema drift and distribution drift produce structurally identical candidate
    rows, so they share this one dataclass. The aliases below preserve the two
    domain-specific names used at call sites.
    """

    id: uuid.UUID
    scan_config_id: uuid.UUID | None
    scope_type: str
    scope_ref: str
    event_id: uuid.UUID | None
    event_type_id: uuid.UUID | None
    bucket: datetime
    direction: str
    actual_count: float
    expected_count: float
    drift_field: str | None
    drift_type: str | None
    sample_value: str | None
    # Start of the window the comparison was measured over. Only release
    # regressions set it (``bucket`` carries the end): their window is the
    # activation-anchored rollout overlap, not the scan's bucket, and a message
    # that quotes an adoption-adjusted expectation has to be able to say which
    # window produced it. Everything else leaves it None and renders unchanged.
    window_from: datetime | None = None


# Same shape, distinct domain names kept for call-site readability.
SchemaDriftAlertCandidate = DriftAlertCandidate
DistributionDriftAlertCandidate = DriftAlertCandidate


def distribution_drift_scope_ref(owner_id: uuid.UUID, field_name: str) -> str:
    field_hash = hashlib.sha1(field_name.encode("utf-8")).hexdigest()[:12]
    return f"{owner_id.hex}:{field_hash}"


def filter_matches_anomaly(filter_row: AlertRuleFilter, anomaly: AlertMatchCandidate) -> bool:
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


def rule_matches_anomaly(rule: AlertRule, anomaly: AlertMatchCandidate) -> bool:
    # Scan gate. NULL on the rule means the whole project — the behaviour every
    # rule had before the column existed, so the migration is a no-op.
    #
    # It lives HERE rather than in ``dispatch._prepare_alert_deliveries`` on
    # purpose. Dispatch already runs per scan config, so an early ``continue``
    # there would be enough for production and invisible to the in-UI simulator,
    # which replays a whole project's anomalies through this function in one
    # pass — the simulator would then over-report a scan-bound rule, which is
    # exactly the drift this module exists to prevent.
    #
    # A ``metric``-scope anomaly is project-global and carries NULL here, so it
    # never equals a bound scan: ``include_metrics`` goes inert on a scan-bound
    # rule, deliberately. A rule that says "this one scan" has nothing to say
    # about a project-wide catalog series.
    if rule.scan_config_id is not None and anomaly.scan_config_id != rule.scan_config_id:
        return False

    # Scope gates.
    if anomaly.scope_type == MetricScopeType.project_total.value and not rule.include_project_total:
        return False
    if anomaly.scope_type == MetricScopeType.event_type.value and not rule.include_event_types:
        return False
    if anomaly.scope_type == MetricScopeType.event.value and not rule.include_events:
        return False
    if anomaly.scope_type == MetricScopeType.schema.value and not rule.include_schema_drifts:
        return False
    if anomaly.scope_type == SCOPE_DISTRIBUTION_DRIFT and not rule.include_distribution_drifts:
        return False
    if anomaly.scope_type == SCOPE_RELEASE_REGRESSION and not rule.include_release_regressions:
        return False
    if anomaly.scope_type == SCOPE_VARIABLE_VALUE_DRIFT and not rule.include_variable_value_drifts:
        return False
    # Catalog metric anomalies are opt-in (SAFE OFF): a rule must explicitly
    # subscribe via include_metrics. They flow through the numeric-threshold
    # branch below (actual/expected counts), like the volume scopes.
    if anomaly.scope_type == SCOPE_METRIC and not rule.include_metrics:
        return False

    # Direction gates.
    if anomaly.direction == "spike" and not rule.notify_on_spike:
        return False
    if anomaly.direction == "drop" and not rule.notify_on_drop:
        return False

    if anomaly.scope_type in {
        MetricScopeType.schema.value,
        SCOPE_DISTRIBUTION_DRIFT,
        SCOPE_RELEASE_REGRESSION,
        SCOPE_VARIABLE_VALUE_DRIFT,
    }:
        return all(filter_matches_anomaly(filter_row, anomaly) for filter_row in rule.filters)

    # Numeric thresholds.
    if anomaly.expected_count < rule.min_expected_count:
        return False
    absolute_delta = abs(anomaly.actual_count - anomaly.expected_count)
    if absolute_delta < rule.min_absolute_delta:
        return False
    # A relative threshold has nothing to divide by when the baseline is zero,
    # and the old fallback answered 0.0 — reporting the largest possible relative
    # move as the smallest. It cost nothing while min_percent_delta defaulted to
    # 0 (``0 < 0`` is false, so such a candidate passed anyway); at the measured
    # default of 100 it silences the whole class, so a scope resuming after an
    # outage, or an event firing for the first time, would match no rule carrying
    # a percent threshold. The asymmetry is what gives it away: the mirror case,
    # actual 0 against a positive expectation, is exactly 100% and alerts.
    #
    # Deliberately NOT scored against ``max(expected, 1)`` the way the UI's
    # relative effect is. That divisor assumes counts, and catalog metrics arrive
    # here with fractional values gated only at 1e-6: a ratio expected 0.2 and
    # observed 0.9 scores 350% today and would score 70% under a floor of one,
    # dropping below the very threshold this is about.
    if anomaly.expected_count > 0:
        if absolute_delta / anomaly.expected_count * 100 < rule.min_percent_delta:
            return False
    elif absolute_delta <= 0:
        # No baseline and no movement: nothing to report.
        return False

    return all(filter_matches_anomaly(filter_row, anomaly) for filter_row in rule.filters)


def rule_covers_event(
    rule: AlertRule,
    *,
    event_id: uuid.UUID,
    event_type_id: uuid.UUID,
) -> bool:
    """Whether an enabled rule *monitors* this event — coverage, not firing.

    Coverage answers "is this event watched by an alert rule at all", a static
    property of the event's identity, as opposed to :func:`rule_matches_anomaly`
    which answers whether a *live anomaly* would deliver. It therefore gates only
    on the event scope toggle (``include_events``) and the identity filters
    (``event`` / ``event_type``); the direction and numeric-threshold gates
    depend on an anomaly's counts, which are not a property of the event, so they
    are deliberately ignored here. Non-identity filters (e.g. ``direction``) are
    firing-time gates and never narrow coverage.

    ``rule.scan_config_id`` is ignored for the same reason: an event belongs to
    a project, not to a scan, and several scans can observe the same one. A
    scan-bound rule still watches the event — just in one scan — so the catalog's
    Monitor column stays truthful.
    """
    if not rule.enabled or not rule.include_events:
        return False
    for filter_row in rule.filters:
        if filter_row.field == "event":
            actual = str(event_id)
        elif filter_row.field == "event_type":
            actual = str(event_type_id)
        else:
            continue
        values = set(filter_row.values or [])
        if filter_row.operator in ("eq", "in") and actual not in values:
            return False
        if filter_row.operator in ("ne", "not_in") and actual in values:
            return False
    return True


def simulate_rule_firings(
    rule: AlertRule,
    anomalies: list[AlertMatchCandidate],
    *,
    cooldown_minutes_override: int | None = None,
) -> list[AlertMatchCandidate]:
    """Replay anomalies through a rule with in-memory cooldown gating.

    Returns the subset that would have triggered a delivery, in bucket order.
    Cooldown is applied per (scope_type, scope_ref) — the same partition the
    live pipeline uses for AlertRuleState. When ``cooldown_minutes_override``
    is set, that value is used in place of ``rule.cooldown_minutes`` so the
    simulator can A/B different cooldowns without writing back to the rule.
    """
    effective_cooldown = (
        cooldown_minutes_override
        if cooldown_minutes_override is not None
        else rule.cooldown_minutes
    )
    cooldown = timedelta(0) if effective_cooldown < 0 else timedelta(minutes=effective_cooldown)

    fired: list[AlertMatchCandidate] = []
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
