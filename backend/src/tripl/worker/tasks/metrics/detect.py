from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy import func as sa_func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_METRIC,
    SCOPE_PROJECT_TOTAL,
    AnomalyDetectionSettings,
    DetectedAnomaly,
    SeriesPoint,
    detect_anomalies,
    required_history_buckets,
)
from tripl.core.intervals import get_interval
from tripl.models.domain_enums import MetricStatus
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.observability.metrics import anomalies_detected_total
from tripl.worker.analyzers.metric_value_kind import is_count_shaped


def _build_anomaly_settings(
    settings: ProjectAnomalySettings,
) -> AnomalyDetectionSettings:
    return AnomalyDetectionSettings(
        baseline_window_buckets=settings.baseline_window_buckets,
        min_history_buckets=settings.min_history_buckets,
        sigma_threshold=settings.sigma_threshold,
        min_expected_count=settings.min_expected_count,
    )


def _get_project_anomaly_settings(
    session: Session,
    project_id: uuid.UUID,
) -> ProjectAnomalySettings | None:
    return session.execute(
        select(ProjectAnomalySettings).where(ProjectAnomalySettings.project_id == project_id)
    ).scalar_one_or_none()


def _scan_has_event_level_breakdown_columns(session: Session, scan_config_id: uuid.UUID) -> bool:
    event_ids = (
        select(EventMetric.event_id)
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_not(None),
        )
        .distinct()
    )
    rows = session.execute(
        select(Event.metric_breakdown_columns).where(Event.id.in_(event_ids))
    ).scalars()
    return any(columns for columns in rows)


def _load_scope_points(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    history_from: datetime,
    time_to: datetime,
) -> list[SeriesPoint]:
    if scope_type == SCOPE_PROJECT_TOTAL:
        rows = session.execute(
            select(EventMetric.bucket, sa_func.sum(EventMetric.count))
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id.is_not(None),
                EventMetric.bucket >= history_from,
                EventMetric.bucket < time_to,
            )
            .group_by(EventMetric.bucket)
            .order_by(EventMetric.bucket)
        ).all()
        return [SeriesPoint(bucket=bucket, count=int(count)) for bucket, count in rows]

    if scope_type == SCOPE_EVENT_TYPE:
        event_type_id = uuid.UUID(scope_ref)
        rows = session.execute(
            select(EventMetric.bucket, EventMetric.count)
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id == event_type_id,
                EventMetric.bucket >= history_from,
                EventMetric.bucket < time_to,
            )
            .order_by(EventMetric.bucket)
        ).all()
        return [SeriesPoint(bucket=bucket, count=count) for bucket, count in rows]

    event_id = uuid.UUID(scope_ref)
    rows = session.execute(
        select(EventMetric.bucket, EventMetric.count)
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id == event_id,
            EventMetric.bucket >= history_from,
            EventMetric.bucket < time_to,
        )
        .order_by(EventMetric.bucket)
    ).all()
    return [SeriesPoint(bucket=bucket, count=count) for bucket, count in rows]


def _replace_scope_anomalies(
    session: Session,
    *,
    scan_config_id: uuid.UUID | None,
    scope_type: str,
    scope_ref: str,
    evaluation_start: datetime,
    evaluation_end: datetime,
    event_id: uuid.UUID | None,
    event_type_id: uuid.UUID | None,
    anomalies: list[DetectedAnomaly],
) -> int:
    # ``metric``-scope rows carry a NULL scan_config_id and are keyed purely by
    # (scope_type, scope_ref); event scopes additionally partition by config.
    delete_filters = [
        MetricAnomaly.scope_type == scope_type,
        MetricAnomaly.scope_ref == scope_ref,
        MetricAnomaly.bucket >= evaluation_start,
        MetricAnomaly.bucket < evaluation_end,
    ]
    if scan_config_id is None:
        delete_filters.append(MetricAnomaly.scan_config_id.is_(None))
    else:
        delete_filters.append(MetricAnomaly.scan_config_id == scan_config_id)
    session.execute(delete(MetricAnomaly).where(*delete_filters))

    rows: list[dict[str, object]] = []
    for anomaly in anomalies:
        rows.append(
            {
                "id": uuid.uuid4(),
                "scan_config_id": scan_config_id,
                "scope_type": scope_type,
                "scope_ref": scope_ref,
                "event_id": event_id,
                "event_type_id": event_type_id,
                "bucket": anomaly.bucket,
                "actual_count": anomaly.actual_count,
                "expected_count": anomaly.expected_count,
                "stddev": anomaly.stddev,
                "z_score": anomaly.z_score,
                "direction": anomaly.direction,
            }
        )
        anomalies_detected_total.labels(scope=scope_type, direction=anomaly.direction).inc()

    # Idempotent insert: a concurrent collect_metrics run over the same window
    # (e.g. a manual replay overlapping a scheduled collection) deletes and
    # re-inserts the same (scope, bucket) rows; a plain INSERT trips the unique
    # index and fails the whole job. Upsert is safe.
    #
    # The conflict target depends on scan_config_id. Event scopes set it, so the
    # composite ``uq_metric_anomaly_scope_bucket`` (which includes it) dedupes
    # them. ``metric`` scopes carry a NULL scan_config_id; SQL treats NULLs as
    # DISTINCT, so that composite constraint NEVER fires for them — two
    # ``(NULL, 'metric', ref, bucket)`` rows from concurrent runs would both
    # insert. We instead target the partial unique index
    # ``uq_metric_anomaly_metric_scope`` (scope_type, scope_ref, bucket) WHERE
    # scan_config_id IS NULL, which excludes the NULL column and so does conflict.
    _updatable = [
        "event_id",
        "event_type_id",
        "actual_count",
        "expected_count",
        "stddev",
        "z_score",
        "direction",
    ]
    null_scope = scan_config_id is None
    if rows:
        if session.bind is not None and session.bind.dialect.name == "sqlite":
            sqlite_stmt = sqlite_insert(MetricAnomaly).values(rows)
            if null_scope:
                sqlite_stmt = sqlite_stmt.on_conflict_do_update(
                    index_elements=["scope_type", "scope_ref", "bucket"],
                    index_where=MetricAnomaly.scan_config_id.is_(None),
                    set_={col: getattr(sqlite_stmt.excluded, col) for col in _updatable},
                )
            else:
                sqlite_stmt = sqlite_stmt.on_conflict_do_update(
                    index_elements=["scan_config_id", "scope_type", "scope_ref", "bucket"],
                    set_={col: getattr(sqlite_stmt.excluded, col) for col in _updatable},
                )
            session.execute(sqlite_stmt)
        else:
            pg_stmt = pg_insert(MetricAnomaly).values(rows)
            if null_scope:
                pg_stmt = pg_stmt.on_conflict_do_update(
                    index_elements=["scope_type", "scope_ref", "bucket"],
                    index_where=MetricAnomaly.scan_config_id.is_(None),
                    set_={col: getattr(pg_stmt.excluded, col) for col in _updatable},
                )
            else:
                pg_stmt = pg_stmt.on_conflict_do_update(
                    constraint="uq_metric_anomaly_scope_bucket",
                    set_={col: getattr(pg_stmt.excluded, col) for col in _updatable},
                )
            session.execute(pg_stmt)

    return len(anomalies)


def _load_breakdown_scope_points(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    breakdown_column: str,
    breakdown_value: str,
    is_other: bool,
    history_from: datetime,
    time_to: datetime,
) -> list[SeriesPoint]:
    query = (
        select(EventMetricBreakdown.bucket, sa_func.sum(EventMetricBreakdown.count))
        .where(
            EventMetricBreakdown.scan_config_id == scan_config_id,
            EventMetricBreakdown.breakdown_column == breakdown_column,
            EventMetricBreakdown.breakdown_value == breakdown_value,
            EventMetricBreakdown.is_other.is_(is_other),
            EventMetricBreakdown.bucket >= history_from,
            EventMetricBreakdown.bucket < time_to,
        )
        .group_by(EventMetricBreakdown.bucket)
        .order_by(EventMetricBreakdown.bucket)
    )

    if scope_type == SCOPE_PROJECT_TOTAL:
        query = query.where(
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id.is_not(None),
        )
    elif scope_type == SCOPE_EVENT_TYPE:
        query = query.where(
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id == uuid.UUID(scope_ref),
        )
    else:
        query = query.where(EventMetricBreakdown.event_id == uuid.UUID(scope_ref))

    rows = session.execute(query).all()
    return [SeriesPoint(bucket=bucket, count=int(count)) for bucket, count in rows]


def _replace_scope_breakdown_anomalies(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    breakdown_column: str,
    breakdown_value: str,
    is_other: bool,
    evaluation_start: datetime,
    evaluation_end: datetime,
    event_id: uuid.UUID | None,
    event_type_id: uuid.UUID | None,
    anomalies: list[DetectedAnomaly],
) -> int:
    session.execute(
        delete(MetricBreakdownAnomaly).where(
            MetricBreakdownAnomaly.scan_config_id == scan_config_id,
            MetricBreakdownAnomaly.scope_type == scope_type,
            MetricBreakdownAnomaly.scope_ref == scope_ref,
            MetricBreakdownAnomaly.breakdown_column == breakdown_column,
            MetricBreakdownAnomaly.breakdown_value == breakdown_value,
            MetricBreakdownAnomaly.is_other.is_(is_other),
            MetricBreakdownAnomaly.bucket >= evaluation_start,
            MetricBreakdownAnomaly.bucket < evaluation_end,
        )
    )

    rows: list[dict[str, object]] = []
    for anomaly in anomalies:
        anomalies_detected_total.labels(
            scope=f"{scope_type}_breakdown", direction=anomaly.direction
        ).inc()
        rows.append(
            {
                "id": uuid.uuid4(),
                "scan_config_id": scan_config_id,
                "scope_type": scope_type,
                "scope_ref": scope_ref,
                "event_id": event_id,
                "event_type_id": event_type_id,
                "bucket": anomaly.bucket,
                "breakdown_column": breakdown_column,
                "breakdown_value": breakdown_value,
                "is_other": is_other,
                "actual_count": anomaly.actual_count,
                "expected_count": anomaly.expected_count,
                "stddev": anomaly.stddev,
                "z_score": anomaly.z_score,
                "direction": anomaly.direction,
            }
        )

    # Idempotent insert — see _replace_scope_anomalies: concurrent runs over the
    # same window must not crash on uq_metric_breakdown_anomaly_scope_bucket_value.
    _updatable = [
        "event_id",
        "event_type_id",
        "actual_count",
        "expected_count",
        "stddev",
        "z_score",
        "direction",
    ]
    if rows:
        if session.bind is not None and session.bind.dialect.name == "sqlite":
            sqlite_stmt = sqlite_insert(MetricBreakdownAnomaly).values(rows)
            sqlite_stmt = sqlite_stmt.on_conflict_do_update(
                index_elements=[
                    "scan_config_id",
                    "scope_type",
                    "scope_ref",
                    "breakdown_column",
                    "breakdown_value",
                    "is_other",
                    "bucket",
                ],
                set_={col: getattr(sqlite_stmt.excluded, col) for col in _updatable},
            )
            session.execute(sqlite_stmt)
        else:
            pg_stmt = pg_insert(MetricBreakdownAnomaly).values(rows)
            pg_stmt = pg_stmt.on_conflict_do_update(
                constraint="uq_metric_breakdown_anomaly_scope_bucket_value",
                set_={col: getattr(pg_stmt.excluded, col) for col in _updatable},
            )
            session.execute(pg_stmt)

    return len(anomalies)


def _collect_scope_ids(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    history_from: datetime,
    evaluation_start: datetime,
    evaluation_end: datetime,
    scope_type: str,
) -> set[uuid.UUID]:
    metric_column = (
        EventMetric.event_type_id if scope_type == SCOPE_EVENT_TYPE else EventMetric.event_id
    )
    anomaly_column = (
        MetricAnomaly.event_type_id if scope_type == SCOPE_EVENT_TYPE else MetricAnomaly.event_id
    )

    if scope_type == SCOPE_EVENT:
        ids = {
            value
            for value in session.execute(
                select(EventMetric.event_id)
                .join(Event, EventMetric.event_id == Event.id)
                .where(
                    EventMetric.scan_config_id == scan_config_id,
                    EventMetric.event_id.is_not(None),
                    EventMetric.bucket >= history_from,
                    EventMetric.bucket < evaluation_end,
                    Event.status != "archived",
                )
            ).scalars()
            if value is not None
        }
        ids.update(
            value
            for value in session.execute(
                select(MetricAnomaly.event_id)
                .join(Event, MetricAnomaly.event_id == Event.id)
                .where(
                    MetricAnomaly.scan_config_id == scan_config_id,
                    MetricAnomaly.scope_type == scope_type,
                    MetricAnomaly.event_id.is_not(None),
                    MetricAnomaly.bucket >= evaluation_start,
                    MetricAnomaly.bucket < evaluation_end,
                    Event.status != "archived",
                )
            ).scalars()
            if value is not None
        )
    else:
        ids = {
            value
            for value in session.execute(
                select(metric_column).where(
                    EventMetric.scan_config_id == scan_config_id,
                    metric_column.is_not(None),
                    EventMetric.bucket >= history_from,
                    EventMetric.bucket < evaluation_end,
                )
            ).scalars()
            if value is not None
        }
        ids.update(
            value
            for value in session.execute(
                select(anomaly_column).where(
                    MetricAnomaly.scan_config_id == scan_config_id,
                    MetricAnomaly.scope_type == scope_type,
                    anomaly_column.is_not(None),
                    MetricAnomaly.bucket >= evaluation_start,
                    MetricAnomaly.bucket < evaluation_end,
                )
            ).scalars()
            if value is not None
        )
    return ids


def _collect_breakdown_scope_keys(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    history_from: datetime,
    evaluation_start: datetime,
    evaluation_end: datetime,
    scope_type: str,
) -> set[tuple[uuid.UUID | None, uuid.UUID | None, str, str, bool]]:
    metric_id_column = (
        EventMetricBreakdown.event_type_id
        if scope_type == SCOPE_EVENT_TYPE
        else EventMetricBreakdown.event_id
    )
    anomaly_id_column = (
        MetricBreakdownAnomaly.event_type_id
        if scope_type == SCOPE_EVENT_TYPE
        else MetricBreakdownAnomaly.event_id
    )

    metric_query = select(
        EventMetricBreakdown.event_id,
        EventMetricBreakdown.event_type_id,
        EventMetricBreakdown.breakdown_column,
        EventMetricBreakdown.breakdown_value,
        EventMetricBreakdown.is_other,
    ).where(
        EventMetricBreakdown.scan_config_id == scan_config_id,
        EventMetricBreakdown.bucket >= history_from,
        EventMetricBreakdown.bucket < evaluation_end,
    )
    anomaly_query = select(
        MetricBreakdownAnomaly.event_id,
        MetricBreakdownAnomaly.event_type_id,
        MetricBreakdownAnomaly.breakdown_column,
        MetricBreakdownAnomaly.breakdown_value,
        MetricBreakdownAnomaly.is_other,
    ).where(
        MetricBreakdownAnomaly.scan_config_id == scan_config_id,
        MetricBreakdownAnomaly.scope_type == scope_type,
        MetricBreakdownAnomaly.bucket >= evaluation_start,
        MetricBreakdownAnomaly.bucket < evaluation_end,
    )

    if scope_type == SCOPE_PROJECT_TOTAL:
        metric_query = metric_query.where(
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id.is_not(None),
        )
    elif scope_type == SCOPE_EVENT:
        metric_query = metric_query.join(Event, EventMetricBreakdown.event_id == Event.id).where(
            EventMetricBreakdown.event_id.is_not(None),
            Event.status != "archived",
        )
        anomaly_query = anomaly_query.join(
            Event,
            MetricBreakdownAnomaly.event_id == Event.id,
        ).where(
            MetricBreakdownAnomaly.event_id.is_not(None),
            Event.status != "archived",
        )
    else:
        metric_query = metric_query.where(metric_id_column.is_not(None))
        anomaly_query = anomaly_query.where(anomaly_id_column.is_not(None))

    keys: set[tuple[uuid.UUID | None, uuid.UUID | None, str, str, bool]] = set()
    for event_id, event_type_id, column, value, is_other in session.execute(metric_query).all():
        if scope_type == SCOPE_PROJECT_TOTAL:
            keys.add((None, None, column, value, bool(is_other)))
        else:
            keys.add((event_id, event_type_id, column, value, bool(is_other)))
    for event_id, event_type_id, column, value, is_other in session.execute(anomaly_query).all():
        if scope_type == SCOPE_PROJECT_TOTAL:
            keys.add((None, None, column, value, bool(is_other)))
        else:
            keys.add((event_id, event_type_id, column, value, bool(is_other)))
    return keys


def _load_metric_value_points(
    session: Session,
    *,
    metric_definition_id: uuid.UUID,
    history_from: datetime,
    time_to: datetime,
) -> list[SeriesPoint]:
    """Load a catalog metric's stored value series as ``SeriesPoint``s.

    Values are summed per bucket (an ``event_composition`` metric may have been
    collected across more than one source grid) and kept as floats — the
    detector is scale-aware, so sub-unit ratio/average movements survive
    instead of rounding toward 0 (tripl-68bc).
    """
    rows = session.execute(
        select(MetricValue.bucket, sa_func.sum(MetricValue.value))
        .where(
            MetricValue.metric_definition_id == metric_definition_id,
            MetricValue.bucket >= history_from,
            MetricValue.bucket < time_to,
        )
        .group_by(MetricValue.bucket)
        .order_by(MetricValue.bucket)
    ).all()
    return [SeriesPoint(bucket=bucket, count=float(value)) for bucket, value in rows]


def _resolve_metric_interval(session: Session, metric: MetricDefinition) -> str | None:
    """Interval for a metric's grid.

    ``sql`` / ``fact`` carry their own ``interval``;
    ``event_composition`` leaves it NULL and inherits the grid of the
    most-recent value's ``scan_config_id`` (mirrors the series read service).
    """
    if metric.interval is not None:
        return metric.interval
    scan_config_id = session.execute(
        select(MetricValue.scan_config_id)
        .where(
            MetricValue.metric_definition_id == metric.id,
            MetricValue.scan_config_id.is_not(None),
        )
        .order_by(MetricValue.bucket.desc())
        .limit(1)
    ).scalar()
    if scan_config_id is None:
        return None
    return session.execute(
        select(ScanConfig.interval).where(ScanConfig.id == scan_config_id)
    ).scalar()


def _project_metric_scope_refs(session: Session, project_id: uuid.UUID) -> list[str]:
    return [
        str(metric_id)
        for metric_id in session.execute(
            select(MetricDefinition.id).where(MetricDefinition.project_id == project_id)
        ).scalars()
    ]


def _purge_project_metric_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    evaluation_start: datetime | None = None,
    evaluation_end: datetime | None = None,
) -> None:
    """Delete ``metric``-scope anomalies for THIS project's metrics.

    Scoped to the project's metric ids so it never touches another project's
    metric-scope rows (which share the global ``scan_config_id IS NULL`` space).
    Without a window it is a full purge (detection disabled); with one it clears
    just the evaluated window.
    """
    scope_refs = _project_metric_scope_refs(session, config.project_id)
    if not scope_refs:
        return
    filters = [
        MetricAnomaly.scope_type == SCOPE_METRIC,
        MetricAnomaly.scope_ref.in_(scope_refs),
    ]
    if evaluation_start is not None:
        filters.append(MetricAnomaly.bucket >= evaluation_start)
    if evaluation_end is not None:
        filters.append(MetricAnomaly.bucket < evaluation_end)
    session.execute(delete(MetricAnomaly).where(*filters))


def _recalculate_project_metric_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    settings: AnomalyDetectionSettings,
    evaluation_start: datetime,
    evaluation_end: datetime,
) -> int:
    """Detect anomalies over the project's active catalog metric series.

    Metric anomalies are project-global: stored with ``scope_type='metric'``,
    ``scope_ref=str(metric_definition_id)`` and a NULL ``scan_config_id``.
    Count-shaped metrics keep the standard zero-fill + ``min_expected_count``
    behavior; fractional metrics (ratios/averages/sql) drop both so sparse or
    sub-unit series do not produce false anomalies.
    """
    metrics = list(
        session.execute(
            select(MetricDefinition).where(
                MetricDefinition.project_id == config.project_id,
                MetricDefinition.status == MetricStatus.active.value,
                MetricDefinition.anomaly_detection_enabled.is_(True),
            )
        ).scalars()
    )
    detected = 0
    for metric in metrics:
        interval = _resolve_metric_interval(session, metric)
        if interval is None:
            continue
        interval_spec = get_interval(interval)
        count_shaped = is_count_shaped(metric)
        metric_settings = settings if count_shaped else replace(settings, min_expected_count=0)
        history_from = evaluation_start - interval_spec.delta * required_history_buckets(
            interval_spec.delta, settings
        )
        points = _load_metric_value_points(
            session,
            metric_definition_id=metric.id,
            history_from=history_from,
            time_to=evaluation_end,
        )
        detected += _replace_scope_anomalies(
            session,
            scan_config_id=None,
            scope_type=SCOPE_METRIC,
            scope_ref=str(metric.id),
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            event_id=None,
            event_type_id=None,
            anomalies=detect_anomalies(
                points,
                interval=interval_spec.delta,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                settings=metric_settings,
                fill_gaps=count_shaped,
            ),
        )
    return detected


def _recalculate_metric_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    evaluation_start: datetime,
    evaluation_end: datetime,
) -> int:
    project_settings = _get_project_anomaly_settings(session, config.project_id)
    if project_settings is None or not project_settings.anomaly_detection_enabled:
        session.execute(delete(MetricAnomaly).where(MetricAnomaly.scan_config_id == config.id))
        _purge_project_metric_anomalies(session, config)
        session.flush()
        return 0

    if not config.interval:
        return 0

    interval_spec = get_interval(config.interval)
    settings = _build_anomaly_settings(project_settings)
    history_from = evaluation_start - interval_spec.delta * required_history_buckets(
        interval_spec.delta, settings
    )
    anomalies_detected = 0

    if project_settings.detect_project_total:
        points = _load_scope_points(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_PROJECT_TOTAL,
            scope_ref=str(config.id),
            history_from=history_from,
            time_to=evaluation_end,
        )
        anomalies_detected += _replace_scope_anomalies(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_PROJECT_TOTAL,
            scope_ref=str(config.id),
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            event_id=None,
            event_type_id=None,
            anomalies=detect_anomalies(
                points,
                interval=interval_spec.delta,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                settings=settings,
            ),
        )
    else:
        session.execute(
            delete(MetricAnomaly).where(
                MetricAnomaly.scan_config_id == config.id,
                MetricAnomaly.scope_type == SCOPE_PROJECT_TOTAL,
                MetricAnomaly.bucket >= evaluation_start,
                MetricAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_event_types:
        for event_type_id in _collect_scope_ids(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT_TYPE,
        ):
            scope_ref = str(event_type_id)
            points = _load_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT_TYPE,
                scope_ref=scope_ref,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT_TYPE,
                scope_ref=scope_ref,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=None,
                event_type_id=event_type_id,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricAnomaly).where(
                MetricAnomaly.scan_config_id == config.id,
                MetricAnomaly.scope_type == SCOPE_EVENT_TYPE,
                MetricAnomaly.bucket >= evaluation_start,
                MetricAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_events:
        for event_id in _collect_scope_ids(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT,
        ):
            scope_ref = str(event_id)
            points = _load_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=scope_ref,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=scope_ref,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=event_id,
                event_type_id=None,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricAnomaly).where(
                MetricAnomaly.scan_config_id == config.id,
                MetricAnomaly.scope_type == SCOPE_EVENT,
                MetricAnomaly.bucket >= evaluation_start,
                MetricAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_metrics:
        anomalies_detected += _recalculate_project_metric_anomalies(
            session,
            config,
            settings=settings,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
        )
    else:
        _purge_project_metric_anomalies(
            session,
            config,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
        )

    session.flush()
    return anomalies_detected


def _recalculate_metric_breakdown_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    evaluation_start: datetime,
    evaluation_end: datetime,
) -> int:
    project_settings = _get_project_anomaly_settings(session, config.project_id)
    if project_settings is None or not project_settings.anomaly_detection_enabled:
        session.execute(
            delete(MetricBreakdownAnomaly).where(MetricBreakdownAnomaly.scan_config_id == config.id)
        )
        session.flush()
        return 0

    if not config.interval or (
        not config.metric_breakdown_columns
        and not _scan_has_event_level_breakdown_columns(session, config.id)
    ):
        session.execute(
            delete(MetricBreakdownAnomaly).where(MetricBreakdownAnomaly.scan_config_id == config.id)
        )
        session.flush()
        return 0

    interval_spec = get_interval(config.interval)
    settings = _build_anomaly_settings(project_settings)
    history_from = evaluation_start - interval_spec.delta * required_history_buckets(
        interval_spec.delta, settings
    )
    anomalies_detected = 0

    if project_settings.detect_project_total:
        for _event_id, _event_type_id, column, value, is_other in _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_PROJECT_TOTAL,
        ):
            points = _load_breakdown_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_PROJECT_TOTAL,
                scope_ref=str(config.id),
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_breakdown_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_PROJECT_TOTAL,
                scope_ref=str(config.id),
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=None,
                event_type_id=None,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricBreakdownAnomaly).where(
                MetricBreakdownAnomaly.scan_config_id == config.id,
                MetricBreakdownAnomaly.scope_type == SCOPE_PROJECT_TOTAL,
                MetricBreakdownAnomaly.bucket >= evaluation_start,
                MetricBreakdownAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_event_types:
        for _event_id, event_type_id, column, value, is_other in _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT_TYPE,
        ):
            if event_type_id is None:
                continue
            scope_ref = str(event_type_id)
            points = _load_breakdown_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT_TYPE,
                scope_ref=scope_ref,
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_breakdown_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT_TYPE,
                scope_ref=scope_ref,
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=None,
                event_type_id=event_type_id,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricBreakdownAnomaly).where(
                MetricBreakdownAnomaly.scan_config_id == config.id,
                MetricBreakdownAnomaly.scope_type == SCOPE_EVENT_TYPE,
                MetricBreakdownAnomaly.bucket >= evaluation_start,
                MetricBreakdownAnomaly.bucket < evaluation_end,
            )
        )

    if project_settings.detect_events:
        for event_id, _event_type_id, column, value, is_other in _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT,
        ):
            if event_id is None:
                continue
            scope_ref = str(event_id)
            points = _load_breakdown_scope_points(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=scope_ref,
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                history_from=history_from,
                time_to=evaluation_end,
            )
            anomalies_detected += _replace_scope_breakdown_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=scope_ref,
                breakdown_column=column,
                breakdown_value=value,
                is_other=is_other,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=event_id,
                event_type_id=None,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=settings,
                ),
            )
    else:
        session.execute(
            delete(MetricBreakdownAnomaly).where(
                MetricBreakdownAnomaly.scan_config_id == config.id,
                MetricBreakdownAnomaly.scope_type == SCOPE_EVENT,
                MetricBreakdownAnomaly.bucket >= evaluation_start,
                MetricBreakdownAnomaly.bucket < evaluation_end,
            )
        )

    session.flush()
    return anomalies_detected
