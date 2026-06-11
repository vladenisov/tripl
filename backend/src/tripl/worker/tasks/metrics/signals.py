"""Signal-state and "latest active anomalies" helpers.

The pieces collect_metrics consults to decide which anomaly rows are still
visible (i.e. show up as monitoring signals on the UI) live here. None of
these are monkey-patched by tests, and they only call sibling helpers from
this module, so the bindings inside this file can stay local.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.alerting_matching import (
    SCOPE_DISTRIBUTION_DRIFT,
    DistributionDriftAlertCandidate,
    SchemaDriftAlertCandidate,
    distribution_drift_scope_ref,
)
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift
from tripl.worker.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
)

from ._helpers import RECENT_SIGNAL_WINDOW, SCOPE_SCHEMA_DRIFT
from .urls import _trim_alert_text


def _format_distribution_drift_sample(drift: DistributionDrift) -> str:
    parts = [f"psi={drift.psi:.3f}"]
    top_movers = drift.top_movers or []
    mover_parts: list[str] = []
    for mover in top_movers[:3]:
        value = str(mover.get("value", ""))
        baseline_share = _mover_float(mover.get("baseline_share")) * 100
        current_share = _mover_float(mover.get("current_share")) * 100
        mover_parts.append(f"{value} {baseline_share:.1f}%->{current_share:.1f}%")
    if mover_parts:
        parts.append(", ".join(mover_parts))
    return _trim_alert_text("; ".join(parts)) or ""


def _mover_float(value: object) -> float:
    if isinstance(value, (int, float, str)):
        return float(value)
    return 0.0


def _classify_signal_state(
    *,
    anomaly_bucket: datetime,
    latest_metric_bucket: datetime | None,
) -> str | None:
    if latest_metric_bucket is None or anomaly_bucket >= latest_metric_bucket:
        return "latest_scan"

    recent_cutoff = datetime.now(UTC)
    if anomaly_bucket.tzinfo is None:
        recent_cutoff = recent_cutoff.replace(tzinfo=None)
    recent_cutoff -= RECENT_SIGNAL_WINDOW
    if anomaly_bucket >= recent_cutoff:
        return "recent"

    return None


def _get_latest_metric_buckets(
    session: Session,
    scan_config_id: uuid.UUID,
) -> dict[tuple[str, str], datetime]:
    latest_metrics: dict[tuple[str, str], datetime] = {}
    latest_project_total_bucket = session.execute(
        select(sa_func.max(EventMetric.bucket)).where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id.is_not(None),
        )
    ).scalar_one_or_none()
    if latest_project_total_bucket is not None:
        latest_metrics[(SCOPE_PROJECT_TOTAL, str(scan_config_id))] = latest_project_total_bucket

    for event_type_id, bucket in session.execute(
        select(EventMetric.event_type_id, sa_func.max(EventMetric.bucket))
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id.is_not(None),
        )
        .group_by(EventMetric.event_type_id)
    ).all():
        if event_type_id is not None:
            latest_metrics[(SCOPE_EVENT_TYPE, str(event_type_id))] = bucket

    for event_id, bucket in session.execute(
        select(EventMetric.event_id, sa_func.max(EventMetric.bucket))
        .join(Event, EventMetric.event_id == Event.id)
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_not(None),
            Event.status != "archived",
        )
        .group_by(EventMetric.event_id)
    ).all():
        if event_id is not None:
            latest_metrics[(SCOPE_EVENT, str(event_id))] = bucket

    return latest_metrics


def _get_visible_signal_scope_keys(
    session: Session,
    scan_config_id: uuid.UUID,
) -> set[tuple[str, str]]:
    latest_metrics = _get_latest_metric_buckets(session, scan_config_id)
    latest_anomalies: dict[tuple[str, str], MetricAnomaly] = {}
    for anomaly in session.execute(
        select(MetricAnomaly)
        .outerjoin(Event, MetricAnomaly.event_id == Event.id)
        .where(
            MetricAnomaly.scan_config_id == scan_config_id,
            (MetricAnomaly.event_id.is_(None)) | (Event.status != "archived"),
        )
        .order_by(MetricAnomaly.bucket.desc())
    ).scalars():
        key = (anomaly.scope_type, anomaly.scope_ref)
        latest_anomalies.setdefault(key, anomaly)

    return {
        key
        for key, anomaly in latest_anomalies.items()
        if _classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metrics.get(key),
        )
        is not None
    }


def _get_latest_active_anomalies(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], MetricAnomaly]:
    latest_metrics = _get_latest_metric_buckets(session, config.id)
    latest_anomalies: dict[tuple[str, str], MetricAnomaly] = {}
    for anomaly in session.execute(
        select(MetricAnomaly)
        .outerjoin(Event, MetricAnomaly.event_id == Event.id)
        .where(
            MetricAnomaly.scan_config_id == config.id,
            (MetricAnomaly.event_id.is_(None)) | (Event.status != "archived"),
        )
        .order_by(MetricAnomaly.bucket.desc())
    ).scalars():
        key = (anomaly.scope_type, anomaly.scope_ref)
        latest_anomalies.setdefault(key, anomaly)

    return {
        key: anomaly
        for key, anomaly in latest_anomalies.items()
        if _classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metrics.get(key),
        )
        == "latest_scan"
    }


def _get_active_schema_drift_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], SchemaDriftAlertCandidate]:
    retention_cutoff = datetime.now(UTC) - timedelta(days=30)
    candidates: dict[tuple[str, str], SchemaDriftAlertCandidate] = {}
    for drift in session.execute(
        select(SchemaDrift)
        .join(EventType, EventType.id == SchemaDrift.event_type_id)
        .where(
            EventType.project_id == config.project_id,
            SchemaDrift.scan_config_id == config.id,
            SchemaDrift.detected_at >= retention_cutoff,
            SchemaDrift.status.in_(("open", "snoozed")),
            (SchemaDrift.status != "snoozed")
            | (SchemaDrift.snoozed_until.is_(None))
            | (SchemaDrift.snoozed_until <= datetime.now(UTC)),
        )
        .order_by(SchemaDrift.detected_at.desc())
    ).scalars():
        scope_ref = str(drift.id)
        candidate = SchemaDriftAlertCandidate(
            id=drift.id,
            scope_type=SCOPE_SCHEMA_DRIFT,
            scope_ref=scope_ref,
            event_id=None,
            event_type_id=drift.event_type_id,
            bucket=drift.detected_at,
            direction="spike",
            actual_count=1,
            expected_count=0.0,
            drift_field=drift.field_name,
            drift_type=drift.drift_type,
            sample_value=_trim_alert_text(drift.sample_value),
        )
        candidates[(candidate.scope_type, candidate.scope_ref)] = candidate
    return candidates


def _get_active_distribution_drift_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], DistributionDriftAlertCandidate]:
    latest_bucket = session.execute(
        select(sa_func.max(DistributionDrift.bucket)).where(
            DistributionDrift.scan_config_id == config.id,
        )
    ).scalar_one_or_none()
    if latest_bucket is None:
        return {}

    candidates: dict[tuple[str, str], DistributionDriftAlertCandidate] = {}
    for drift in session.execute(
        select(DistributionDrift)
        .where(
            DistributionDrift.scan_config_id == config.id,
            DistributionDrift.bucket == latest_bucket,
            DistributionDrift.band == "significant",
        )
        .order_by(DistributionDrift.field_name)
    ).scalars():
        owner_id = drift.event_type_id or drift.scan_config_id
        scope_ref = distribution_drift_scope_ref(owner_id, drift.field_name)
        candidate = DistributionDriftAlertCandidate(
            id=drift.id,
            scope_type=SCOPE_DISTRIBUTION_DRIFT,
            scope_ref=scope_ref,
            event_id=None,
            event_type_id=drift.event_type_id,
            bucket=drift.bucket,
            direction="spike",
            actual_count=drift.current_total,
            expected_count=float(drift.baseline_total),
            drift_field=drift.field_name,
            drift_type="distribution_shift",
            sample_value=_format_distribution_drift_sample(drift),
        )
        candidates[(candidate.scope_type, candidate.scope_ref)] = candidate
    return candidates
