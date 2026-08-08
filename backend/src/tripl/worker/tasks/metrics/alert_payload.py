"""Alert payload helpers: scope-name lookup, destination loader, snapshot.

The live alert dispatch loop lives in `dispatch.py`; these small builders stay
separate because they are also useful to inspect and test independently.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.alert_templates import percent_delta_or_none
from tripl.alerting_matching import (
    SCOPE_DISTRIBUTION_DRIFT,
    SCOPE_METRIC,
    SCOPE_RELEASE_REGRESSION,
    SCOPE_VARIABLE_VALUE_DRIFT,
    AlertMatchCandidate,
)
from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
)
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.metric_definition import MetricDefinition
from tripl.models.scan_config import ScanConfig

from ._helpers import SCOPE_SCHEMA_DRIFT
from .urls import _build_item_paths


def _build_alert_scope_names(
    session: Session,
    anomalies: list[AlertMatchCandidate],
) -> dict[tuple[str, str], str]:
    scope_names: dict[tuple[str, str], str] = {
        (SCOPE_PROJECT_TOTAL, anomaly.scope_ref): "All events"
        for anomaly in anomalies
        if anomaly.scope_type == SCOPE_PROJECT_TOTAL
    }

    event_type_ids = {
        anomaly.event_type_id for anomaly in anomalies if anomaly.event_type_id is not None
    }
    if event_type_ids:
        event_type_names: dict[uuid.UUID, str] = {}
        for event_type_id, display_name, name in session.execute(
            select(EventType.id, EventType.display_name, EventType.name).where(
                EventType.id.in_(event_type_ids)
            )
        ).all():
            event_type_name = display_name or name
            event_type_names[event_type_id] = event_type_name
            scope_names[(SCOPE_EVENT_TYPE, str(event_type_id))] = event_type_name
        for anomaly in anomalies:
            if anomaly.event_type_id is None:
                continue
            event_type_name = event_type_names.get(anomaly.event_type_id, "Event type")
            drift_field = getattr(anomaly, "drift_field", None) or anomaly.scope_ref
            if anomaly.scope_type == SCOPE_SCHEMA_DRIFT:
                scope_names[(SCOPE_SCHEMA_DRIFT, anomaly.scope_ref)] = (
                    f"{event_type_name}.{drift_field}"
                )
            elif anomaly.scope_type == SCOPE_DISTRIBUTION_DRIFT:
                scope_names[(SCOPE_DISTRIBUTION_DRIFT, anomaly.scope_ref)] = (
                    f"{event_type_name}.{drift_field}"
                )

    for anomaly in anomalies:
        if anomaly.scope_type != SCOPE_DISTRIBUTION_DRIFT or anomaly.event_type_id is not None:
            continue
        drift_field = getattr(anomaly, "drift_field", None) or anomaly.scope_ref
        scope_names[(SCOPE_DISTRIBUTION_DRIFT, anomaly.scope_ref)] = f"All events.{drift_field}"

    event_ids = {anomaly.event_id for anomaly in anomalies if anomaly.event_id is not None}
    if event_ids:
        event_names_by_id: dict[uuid.UUID, str] = {}
        for event_id, name in session.execute(
            select(Event.id, Event.name).where(Event.id.in_(event_ids))
        ).all():
            event_names_by_id[event_id] = name
            scope_names[(SCOPE_EVENT, str(event_id))] = name
        for anomaly in anomalies:
            if anomaly.scope_type != SCOPE_VARIABLE_VALUE_DRIFT or anomaly.event_id is None:
                continue
            event_name = event_names_by_id.get(anomaly.event_id, "Event")
            drift_field = getattr(anomaly, "drift_field", None) or anomaly.scope_ref
            scope_names[(SCOPE_VARIABLE_VALUE_DRIFT, anomaly.scope_ref)] = (
                f"{event_name}.{drift_field}"
            )

    # Catalog metric anomalies resolve to the metric's display name (scope_ref is
    # the metric definition id).
    metric_scope_refs = {
        anomaly.scope_ref for anomaly in anomalies if anomaly.scope_type == SCOPE_METRIC
    }
    if metric_scope_refs:
        metric_ids = {uuid.UUID(ref) for ref in metric_scope_refs}
        for metric_id, display_name in session.execute(
            select(MetricDefinition.id, MetricDefinition.display_name).where(
                MetricDefinition.id.in_(metric_ids)
            )
        ).all():
            scope_names[(SCOPE_METRIC, str(metric_id))] = display_name

    # Release regressions borrow the name of their underlying event / event type
    # (already resolved above) so the message shows "Login", not a raw UUID.
    for anomaly in anomalies:
        if anomaly.scope_type != SCOPE_RELEASE_REGRESSION:
            continue
        if anomaly.event_id is not None:
            underlying = scope_names.get((SCOPE_EVENT, str(anomaly.event_id)))
        elif anomaly.event_type_id is not None:
            underlying = scope_names.get((SCOPE_EVENT_TYPE, str(anomaly.event_type_id)))
        else:
            underlying = None
        if underlying is not None:
            scope_names[(anomaly.scope_type, anomaly.scope_ref)] = underlying

    for anomaly in anomalies:
        key = (anomaly.scope_type, anomaly.scope_ref)
        scope_names.setdefault(key, anomaly.scope_ref)
    return scope_names


def _load_enabled_alert_destinations(
    session: Session,
    project_id: uuid.UUID,
) -> list[AlertDestination]:
    return list(
        session.execute(
            select(AlertDestination)
            .where(
                AlertDestination.project_id == project_id,
                AlertDestination.enabled.is_(True),
            )
            .order_by(AlertDestination.created_at.desc())
        )
        .scalars()
        .unique()
        .all()
    )


def _build_delivery_snapshot(
    config: ScanConfig,
    *,
    project_slug: str,
    rule: AlertRule,
    destination: AlertDestination,
    anomalies: list[AlertMatchCandidate],
    scope_names: dict[tuple[str, str], str],
    delivery_id: uuid.UUID | None = None,
) -> dict[str, object]:
    """Freeze what this delivery said, for the audit log and the Inbox.

    ``delivery_id`` is threaded in because release-regression items link back
    to this delivery's own audit row — the only surface that can show their
    numbers for one scope. Callers flush the delivery first so the id exists;
    ``None`` degrades to a link-less item rather than a wrong one.
    """
    items: list[dict[str, object]] = []
    for anomaly in anomalies:
        details_path, monitoring_path = _build_item_paths(
            project_slug,
            scope_type=anomaly.scope_type,
            scope_ref=anomaly.scope_ref,
            event_id=anomaly.event_id,
            delivery_id=delivery_id,
        )
        expected = anomaly.expected_count
        absolute_delta = abs(anomaly.actual_count - expected)
        # Gate and output must read the SAME number. Rounding the emitted field
        # while gating the percent on the unrounded value let an anomaly with
        # 0 < expected < 0.5 emit ``expected_count: 0`` beside a non-null
        # percent — precisely the pair alerting.md tells consumers is impossible,
        # and the pair it tells them to disambiguate on. Reachable for
        # ratio-shaped catalog metrics and sparse count series whose rolling
        # expectation is fractional.
        rounded_expected = round(expected)
        items.append(
            {
                "scope_type": anomaly.scope_type,
                "scope_ref": anomaly.scope_ref,
                "scope_name": scope_names[(anomaly.scope_type, anomaly.scope_ref)],
                "direction": anomaly.direction,
                "actual_count": anomaly.actual_count,
                "expected_count": rounded_expected,
                "absolute_delta": round(absolute_delta),
                # ``null`` rather than the stored 0.0 placeholder when there was
                # no baseline: this blob is read as JSON (the Inbox, the audit
                # API, anything reading ``AlertDelivery.payload_snapshot``), and
                # a number there is indistinguishable from "no change"
                # (tripl-l429.27). Rows written before that change still carry
                # 0.0 — a frozen record is not rewritten — so a consumer reading
                # historical deliveries disambiguates on ``expected_count == 0``.
                "percent_delta": percent_delta_or_none(
                    absolute_delta / expected * 100 if expected > 0 else 0.0,
                    rounded_expected,
                ),
                "details_path": details_path,
                "monitoring_path": monitoring_path,
                "drift_field": getattr(anomaly, "drift_field", None),
                "drift_type": getattr(anomaly, "drift_type", None),
                "sample_value": getattr(anomaly, "sample_value", None),
            }
        )
    return {
        "project_slug": project_slug,
        "scan_name": config.name,
        "destination_name": destination.name,
        "rule_name": rule.name,
        "channel": destination.type,
        "matched_count": len(anomalies),
        "items": items,
    }
