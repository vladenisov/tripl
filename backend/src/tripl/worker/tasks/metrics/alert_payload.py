"""Alert payload helpers: scope-name lookup, destination loader, snapshot.

`_prepare_alert_deliveries` stays in `__init__.py` because tests monkey-patch
it, but the small builders it composes have no patches against them and only
call sibling helpers from this package, so they live here.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.alerting_matching import AlertMatchCandidate
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.scan_config import ScanConfig
from tripl.worker.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
)

from ._helpers import SCOPE_SCHEMA_DRIFT
from .urls import _build_event_details_url, _build_monitoring_url


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
            if anomaly.scope_type != SCOPE_SCHEMA_DRIFT or anomaly.event_type_id is None:
                continue
            event_type_name = event_type_names.get(anomaly.event_type_id, "Schema")
            drift_field = getattr(anomaly, "drift_field", None) or anomaly.scope_ref
            scope_names[(SCOPE_SCHEMA_DRIFT, anomaly.scope_ref)] = (
                f"{event_type_name}.{drift_field}"
            )

    event_ids = {anomaly.event_id for anomaly in anomalies if anomaly.event_id is not None}
    if event_ids:
        for event_id, name in session.execute(
            select(Event.id, Event.name).where(Event.id.in_(event_ids))
        ).all():
            scope_names[(SCOPE_EVENT, str(event_id))] = name

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
) -> dict[str, object]:
    return {
        "project_slug": project_slug,
        "scan_name": config.name,
        "destination_name": destination.name,
        "rule_name": rule.name,
        "channel": destination.type,
        "matched_count": len(anomalies),
        "items": [
            {
                "scope_type": anomaly.scope_type,
                "scope_ref": anomaly.scope_ref,
                "scope_name": scope_names[(anomaly.scope_type, anomaly.scope_ref)],
                "direction": anomaly.direction,
                "actual_count": anomaly.actual_count,
                "expected_count": round(anomaly.expected_count),
                "absolute_delta": round(abs(anomaly.actual_count - anomaly.expected_count)),
                "percent_delta": (
                    abs(anomaly.actual_count - anomaly.expected_count)
                    / anomaly.expected_count
                    * 100
                    if anomaly.expected_count > 0
                    else 0.0
                ),
                "details_path": _build_event_details_url(project_slug, anomaly.event_id),
                "monitoring_path": _build_monitoring_url(
                    project_slug,
                    scope_type=anomaly.scope_type,
                    scope_ref=anomaly.scope_ref,
                ),
                "drift_field": getattr(anomaly, "drift_field", None),
                "drift_type": getattr(anomaly, "drift_type", None),
                "sample_value": getattr(anomaly, "sample_value", None),
            }
            for anomaly in anomalies
        ],
    }
