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
    SCOPE_RELEASE_REGRESSION,
    SCOPE_VARIABLE_VALUE_DRIFT,
    DistributionDriftAlertCandidate,
    DriftAlertCandidate,
    SchemaDriftAlertCandidate,
    distribution_drift_scope_ref,
)
from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_METRIC,
    SCOPE_PROJECT_TOTAL,
)
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.release_regression import ReleaseRegression
from tripl.models.scan_config import ScanConfig
from tripl.models.schema_drift import SchemaDrift
from tripl.models.variable import Variable
from tripl.models.variable_value_drift import VariableValueDrift

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


# Mirror of tripl.services.monitoring_utils; kept local so the worker's signal
# helpers do not import the async request-path services layer (see module docstring).
# See that module for the rationale behind the wall-clock freshness cap.
LATEST_SCAN_STALE_INTERVALS = 3

_SCAN_INTERVAL_DELTAS: dict[str, timedelta] = {
    "15m": timedelta(minutes=15),
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "1d": timedelta(days=1),
    "1w": timedelta(weeks=1),
}


def _scan_interval_delta(interval: str | None) -> timedelta | None:
    if interval is None:
        return None
    return _SCAN_INTERVAL_DELTAS.get(str(interval))


def _bucket_is_recent(bucket: datetime, cutoff: datetime) -> bool:
    if bucket.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=None)
    return bucket >= cutoff


def _scan_config_freshness_inputs(
    session: Session,
    scan_config_id: uuid.UUID,
) -> tuple[timedelta | None, timedelta | None]:
    """The scan's interval and the project's configured open-signal window.

    Both are needed together: the latest-scan horizon is
    ``max(window, 3 × interval)``, so resolving the window without the interval
    would drop the floor that keeps a long-interval (daily/weekly) scan's signal
    open. ``None`` for either leaves ``_classify_signal_state`` on its default.
    One query per scan, never per signal. Only the display path resolves this —
    alert candidates stay on the fixed window (see ``_get_latest_active_anomalies``).
    """
    row = session.execute(
        select(ScanConfig.interval, ProjectAnomalySettings.recent_signal_window_hours)
        .outerjoin(
            ProjectAnomalySettings,
            ProjectAnomalySettings.project_id == ScanConfig.project_id,
        )
        .where(ScanConfig.id == scan_config_id)
    ).first()
    if row is None:
        return None, None
    interval, hours = row
    return (
        _scan_interval_delta(interval),
        None if hours is None else timedelta(hours=int(hours)),
    )


def _classify_signal_state(
    *,
    anomaly_bucket: datetime,
    latest_metric_bucket: datetime | None,
    now: datetime | None = None,
    interval: timedelta | None = None,
    recent_window: timedelta | None = None,
) -> str | None:
    # No stored metric values -> no live scan to anchor recency on; treat as closed.
    if latest_metric_bucket is None:
        return None

    reference = now if now is not None else datetime.now(UTC)
    window = recent_window if recent_window is not None else RECENT_SIGNAL_WINDOW

    if anomaly_bucket >= latest_metric_bucket:
        horizon = (
            window if interval is None else max(window, LATEST_SCAN_STALE_INTERVALS * interval)
        )
        # A stopped scan's final anomaly stays at max(bucket) forever; only keep it
        # "latest_scan" while it is still fresh in wall-clock terms.
        if _bucket_is_recent(anomaly_bucket, reference - horizon):
            return "latest_scan"

    if _bucket_is_recent(anomaly_bucket, reference - window):
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

    interval, recent_window = _scan_config_freshness_inputs(session, scan_config_id)
    return {
        key
        for key, anomaly in latest_anomalies.items()
        if _classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metrics.get(key),
            interval=interval,
            recent_window=recent_window,
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

    interval = _scan_interval_delta(config.interval)
    # Deliberately NOT narrowed by the project's open-signal window: this feeds
    # alert dispatch, which closes AlertRuleState rows for scopes that drop out.
    # Honouring a shortened window here would let a presentation setting close
    # alert state and re-trigger the same alert past its cooldown.
    return {
        key: anomaly
        for key, anomaly in latest_anomalies.items()
        if _classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metrics.get(key),
            interval=interval,
        )
        == "latest_scan"
    }


def _get_active_metric_anomaly_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], MetricAnomaly]:
    """Latest active ``metric``-scope anomaly per catalog metric in the project.

    Catalog metric anomalies are project-global (NULL ``scan_config_id``), so —
    unlike event scopes — they are not picked up by the config-partitioned
    ``_get_latest_active_anomalies``. We load them here keyed by their metric
    definition, classify against the latest stored value bucket, and keep only
    the ones whose newest anomaly is on the latest scan (an open signal).
    """
    scope_refs = [
        str(metric_id)
        for metric_id in session.execute(
            select(MetricDefinition.id).where(
                MetricDefinition.project_id == config.project_id,
                MetricDefinition.anomaly_detection_enabled.is_(True),
            )
        ).scalars()
    ]
    if not scope_refs:
        return {}

    metric_ids = [uuid.UUID(ref) for ref in scope_refs]
    latest_value_buckets: dict[str, datetime] = {
        str(metric_definition_id): bucket
        for metric_definition_id, bucket in session.execute(
            select(MetricValue.metric_definition_id, sa_func.max(MetricValue.bucket))
            .where(MetricValue.metric_definition_id.in_(metric_ids))
            .group_by(MetricValue.metric_definition_id)
        ).all()
    }

    latest_anomalies: dict[str, MetricAnomaly] = {}
    for anomaly in session.execute(
        select(MetricAnomaly)
        .where(
            MetricAnomaly.scope_type == SCOPE_METRIC,
            MetricAnomaly.scope_ref.in_(scope_refs),
        )
        .order_by(MetricAnomaly.bucket.desc())
    ).scalars():
        latest_anomalies.setdefault(anomaly.scope_ref, anomaly)

    interval = _scan_interval_delta(config.interval)
    # See _get_latest_active_anomalies: alert candidates stay on the fixed
    # window so the presentation setting cannot close alert state.
    return {
        (SCOPE_METRIC, scope_ref): anomaly
        for scope_ref, anomaly in latest_anomalies.items()
        if _classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_value_buckets.get(scope_ref),
            interval=interval,
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


def _get_active_variable_value_drift_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], DriftAlertCandidate]:
    """Turn open/snooze-expired variable value drifts into alert candidates.

    Rides the shared drift fields: variable display name -> drift_field,
    "value_drift" -> drift_type, sampled novel values -> sample_value. The
    per-event anchor flows through ``event_id`` so event filters apply.
    """
    retention_cutoff = datetime.now(UTC) - timedelta(days=30)
    candidates: dict[tuple[str, str], DriftAlertCandidate] = {}
    for drift, variable_name in session.execute(
        select(VariableValueDrift, Variable.name)
        .join(Variable, Variable.id == VariableValueDrift.variable_id)
        .where(
            VariableValueDrift.project_id == config.project_id,
            VariableValueDrift.scan_config_id == config.id,
            VariableValueDrift.detected_at >= retention_cutoff,
            VariableValueDrift.status.in_(("open", "snoozed")),
            (VariableValueDrift.status != "snoozed")
            | (VariableValueDrift.snoozed_until.is_(None))
            | (VariableValueDrift.snoozed_until <= datetime.now(UTC)),
        )
        .order_by(VariableValueDrift.detected_at.desc())
    ).all():
        scope_ref = str(drift.id)
        candidate = DriftAlertCandidate(
            id=drift.id,
            scope_type=SCOPE_VARIABLE_VALUE_DRIFT,
            scope_ref=scope_ref,
            event_id=drift.event_id,
            event_type_id=None,
            bucket=drift.detected_at,
            direction="spike",
            actual_count=float(len(drift.observed_values or [])),
            expected_count=0.0,
            drift_field=variable_name,
            drift_type="value_drift",
            sample_value=_trim_alert_text(", ".join(drift.observed_values or [])),
        )
        candidates[(candidate.scope_type, candidate.scope_ref)] = candidate
    return candidates


def _get_active_release_regression_candidates(
    session: Session,
    config: ScanConfig,
) -> dict[tuple[str, str], DriftAlertCandidate]:
    """Turn the scan's current ReleaseRegression rows into alert candidates.

    The recalculation step keeps only the latest release's regressions, so every
    row here is current. Version context rides on the shared drift fields
    (version -> drift_field, kind -> drift_type, previous release -> sample_value)
    so it flows through the existing delivery-item and message machinery.
    Naturally inert: no rows exist when the scan has no version column.
    """
    if not config.app_version_column:
        return {}
    candidates: dict[tuple[str, str], DriftAlertCandidate] = {}
    for regression in session.execute(
        select(ReleaseRegression)
        .where(ReleaseRegression.scan_config_id == config.id)
        .order_by(ReleaseRegression.scope_ref)
    ).scalars():
        candidate = DriftAlertCandidate(
            id=regression.id,
            scope_type=SCOPE_RELEASE_REGRESSION,
            scope_ref=regression.scope_ref,
            event_id=regression.event_id,
            event_type_id=regression.event_type_id,
            bucket=regression.window_to,
            direction="drop",
            actual_count=regression.observed_count,
            expected_count=regression.expected_count,
            drift_field=regression.version,
            drift_type=regression.kind,
            sample_value=regression.previous_version,
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
