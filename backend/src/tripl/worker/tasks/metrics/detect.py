from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy import func as sa_func
from sqlalchemy import or_ as sa_or
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
    is_provably_silent,
    required_history_buckets,
    settling_buckets_for,
)
from tripl.core.intervals import get_interval
from tripl.models.anomaly_scope_override import AnomalyScopeOverride
from tripl.models.domain_enums import MetricBreakdownAnomalyKind, MetricStatus
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

# Fractional (ratio/average/sql) catalog metrics drop the count-shaped
# ``min_expected_count`` gate so sub-unit ratio movements survive (tripl-68bc).
# We keep a tiny POSITIVE floor rather than a blanket 0 so a genuinely
# empty/flatlined-at-zero fractional series can't manufacture multi-sigma
# anomalies from pure noise — the detector lane widens the stddev floor, this
# preserves the volume guard (tripl-dmch.17).
_FRACTIONAL_MIN_EXPECTED_COUNT = 1e-6
# Age-out horizon for config-scoped anomaly markers. Rows older than this are
# deleted during each recompute so stale historical dots stop being served as
# active markers. Kept generous: the serving/classify layer (Wave 1 wall-clock
# freshness horizon in ``monitoring_utils.classify_signal_state``) already
# ages markers out for rendering, so this only trims long-dead rows and never
# touches ``metric``-scope rows (NULL scan_config_id, shared across configs).
ANOMALY_RETENTION_DAYS = 180
# Anomaly re-evaluation always sweeps at least this many trailing buckets, even
# on an incremental run that only collected the newest one or two. A backfilled
# or re-collected bucket inside this window then gets its flag cleared/updated on
# the next run instead of being frozen at whatever the first pass decided
# (tripl-dmch.14). Replays over a wider explicit window keep that wider window.
#
# The count is in buckets OF THE SERIES BEING SCORED, which is why it lives here
# rather than in the scan orchestrator: catalog metrics carry their own grid.
# Multiplying it by the scan config's 1h delta gave a 1d metric a 30-HOUR
# window — one candidate bucket, which the settling allowance then withheld, so
# the metric could never emit. A 1d series with a 25-day collapse scored 264
# anomalies on its own grid and 0 on the 1h scan grid.
ANOMALY_TRAILING_REEVAL_BUCKETS = 30
# Default ingestion-settling allowance for the recalculation entrypoints: none.
# The scan orchestrator owns the policy and passes its own allowance (see
# ``tasks.ANOMALY_INGESTION_SETTLING``); callers that hand in an explicit,
# already-settled window (replays, tests, conformance harnesses) get the
# historical behavior of scoring every bucket they asked for.
NO_INGESTION_SETTLING = timedelta(0)


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


# Per-scope sensitivity written by the false-positive ratchet, keyed the way an
# anomaly keys itself. Loaded ONCE per recalculation and applied per scope — a
# per-scope override nobody reads would be worse than the project-wide ratchet
# it replaced, since the operator would be told the scope was tuned and nothing
# would change.
ScopeOverrides = dict[tuple[str, str], tuple[float, int]]


def _load_scope_overrides(
    session: Session,
    *,
    project_id: uuid.UUID,
    scan_config_id: uuid.UUID,
) -> ScopeOverrides:
    """Overrides that can apply to this config's recalculation.

    Both this config's rows AND the project's NULL-config rows: ``metric`` scopes
    are project-global (their ``MetricAnomaly`` rows carry a NULL scan_config_id)
    yet are recomputed from inside a scan's run. The two sets cannot collide —
    ``metric`` is the only scope type stored with a NULL config.
    """
    rows = session.execute(
        select(AnomalyScopeOverride).where(
            AnomalyScopeOverride.project_id == project_id,
            sa_or(
                AnomalyScopeOverride.scan_config_id == scan_config_id,
                AnomalyScopeOverride.scan_config_id.is_(None),
            ),
        )
    ).scalars()
    return {
        (str(row.scope_type), row.scope_ref): (
            float(row.sigma_threshold),
            int(row.min_expected_count),
        )
        for row in rows
    }


def _scope_settings(
    settings: AnomalyDetectionSettings,
    overrides: ScopeOverrides,
    scope_type: str,
    scope_ref: str,
) -> AnomalyDetectionSettings:
    override = overrides.get((scope_type, scope_ref))
    if override is None:
        return settings
    sigma_threshold, min_expected_count = override
    return replace(
        settings,
        sigma_threshold=sigma_threshold,
        min_expected_count=min_expected_count,
    )


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
                # C3 columns: the floored stddev actually used in the z
                # denominator and which detector path produced the row, sourced
                # from the DetectedAnomaly (C1) so the chart band and marker
                # provenance stay consistent with what was flagged.
                "effective_stddev": anomaly.effective_stddev,
                "detector_kind": anomaly.kind,
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
        "effective_stddev",
        "detector_kind",
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


def _load_platform_ratio_points(
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
    covered_buckets: set[datetime] | None = None,
    total_points: list[SeriesPoint] | None = None,
) -> list[SeriesPoint]:
    breakdown_points = _load_breakdown_scope_points(
        session,
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        breakdown_column=breakdown_column,
        breakdown_value=breakdown_value,
        is_other=is_other,
        history_from=history_from,
        time_to=time_to,
    )
    breakdown_by_bucket = {point.bucket: point.count for point in breakdown_points}
    # The scope TOTAL is the same series for every breakdown value of that scope,
    # so the caller may hand in a cached copy instead of re-reading ~500 rows once
    # per platform value (tripl-jfm3.1).
    if total_points is None:
        total_points = _load_scope_points(
            session,
            scan_config_id=scan_config_id,
            scope_type=scope_type,
            scope_ref=scope_ref,
            history_from=history_from,
            time_to=time_to,
        )
    return [
        SeriesPoint(
            bucket=point.bucket,
            count=breakdown_by_bucket.get(point.bucket, 0) / point.count,
        )
        for point in total_points
        if point.count > 0 and (covered_buckets is None or point.bucket in covered_buckets)
    ]


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
    kind: MetricBreakdownAnomalyKind = MetricBreakdownAnomalyKind.volume,
) -> int:
    session.execute(
        delete(MetricBreakdownAnomaly).where(
            MetricBreakdownAnomaly.scan_config_id == scan_config_id,
            MetricBreakdownAnomaly.scope_type == scope_type,
            MetricBreakdownAnomaly.scope_ref == scope_ref,
            MetricBreakdownAnomaly.breakdown_column == breakdown_column,
            MetricBreakdownAnomaly.breakdown_value == breakdown_value,
            MetricBreakdownAnomaly.is_other.is_(is_other),
            MetricBreakdownAnomaly.kind == kind,
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
                "kind": kind,
                "actual_count": anomaly.actual_count,
                "expected_count": anomaly.expected_count,
                "stddev": anomaly.stddev,
                "z_score": anomaly.z_score,
                "direction": anomaly.direction,
                # C3 columns sourced from the DetectedAnomaly (C1); see
                # _replace_scope_anomalies.
                "effective_stddev": anomaly.effective_stddev,
                "detector_kind": anomaly.kind,
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
        "effective_stddev",
        "detector_kind",
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
                    "kind",
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


def _scope_max_counts(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    history_from: datetime,
    time_to: datetime,
) -> dict[uuid.UUID, float]:
    """MAX(count) per scope over the detection history window, in one query.

    The prefilter for the silent-series early exit (tripl-h353): a scope whose
    max count satisfies ``is_provably_silent`` against ``min_expected_count``
    cannot emit, so the caller skips loading its ~500-row history and the
    detector entirely. The filters mirror ``_load_scope_points`` exactly:
    event-type rows are the ``event_id IS NULL`` rollups, event rows are keyed
    by ``event_id``. Zero-fill only ever adds zeros, so this stored-row MAX is
    an upper bound on the max the detector itself would see.
    """
    metric_column = (
        EventMetric.event_type_id if scope_type == SCOPE_EVENT_TYPE else EventMetric.event_id
    )
    filters = [
        EventMetric.scan_config_id == scan_config_id,
        metric_column.is_not(None),
        EventMetric.bucket >= history_from,
        EventMetric.bucket < time_to,
    ]
    if scope_type == SCOPE_EVENT_TYPE:
        filters.append(EventMetric.event_id.is_(None))
    rows = session.execute(
        select(metric_column, sa_func.max(EventMetric.count))
        .where(*filters)
        .group_by(metric_column)
    ).all()
    return {scope_id: float(max_count) for scope_id, max_count in rows}


def _breakdown_scope_max_counts(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    history_from: datetime,
    time_to: datetime,
) -> dict[tuple[uuid.UUID, str, str, bool], float]:
    """MAX(count) per breakdown series over the detection history window, in one query.

    The breakdown twin of ``_scope_max_counts`` (tripl-h353). ``detect_anomalies``
    already early-exits on a provably-silent count series, but only AFTER the
    caller has loaded that series' ~500-bucket history — one query per silent
    (scope, column, value) triple, on every run, on a project that may have
    hundreds of them. Event and event-type breakdown series carry exactly one
    stored row per bucket (``uq_event_metric_breakdown_config_event_bucket_value``
    / ``..._type_bucket_value``), so this stored-row MAX is precisely the max the
    detector sees once the grid is zero-filled — the skip is exact, not a
    heuristic. ``project_total`` is excluded on purpose: its series SUMS across
    event types, so no per-row MAX bounds it.
    """
    id_column = (
        EventMetricBreakdown.event_type_id
        if scope_type == SCOPE_EVENT_TYPE
        else EventMetricBreakdown.event_id
    )
    filters = [
        EventMetricBreakdown.scan_config_id == scan_config_id,
        id_column.is_not(None),
        EventMetricBreakdown.bucket >= history_from,
        EventMetricBreakdown.bucket < time_to,
    ]
    if scope_type == SCOPE_EVENT_TYPE:
        filters.append(EventMetricBreakdown.event_id.is_(None))
    rows = session.execute(
        select(
            id_column,
            EventMetricBreakdown.breakdown_column,
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            sa_func.max(EventMetricBreakdown.count),
        )
        .where(*filters)
        .group_by(
            id_column,
            EventMetricBreakdown.breakdown_column,
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
        )
    ).all()
    return {
        (scope_id, column, value, bool(is_other)): float(max_count)
        for scope_id, column, value, is_other, max_count in rows
    }


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
    app_version_column: str | None = None,
    kind: MetricBreakdownAnomalyKind = MetricBreakdownAnomalyKind.volume,
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
        MetricBreakdownAnomaly.kind == kind,
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

    if not app_version_column:
        return keys

    # App-version series describe rollout adoption rather than a stable cohort:
    # each release naturally ramps up and then declines as the next one ships.
    # Running the generic per-breakdown detector on those lifecycle curves
    # creates noise. Dedicated release-regression detection handles version
    # correctness; every other breakdown column stays monitored here.
    return {key for key in keys if key[2] != app_version_column}


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
    evaluation_end: datetime | None = None,
) -> None:
    """Delete ``metric``-scope anomalies for THIS project's metrics.

    Scoped to the project's metric ids so it never touches another project's
    metric-scope rows (which share the global ``scan_config_id IS NULL`` space).

    There is deliberately no start bound. Each metric writes its rows over its
    OWN grid's trailing window, so the earliest row a project can hold is set by
    its longest interval, not by the scan-grid window a caller happens to hold;
    bounding the purge by that window would strand every older row as a marker
    no later run re-evaluates.
    """
    scope_refs = _project_metric_scope_refs(session, config.project_id)
    if not scope_refs:
        return
    filters = [
        MetricAnomaly.scope_type == SCOPE_METRIC,
        MetricAnomaly.scope_ref.in_(scope_refs),
    ]
    if evaluation_end is not None:
        filters.append(MetricAnomaly.bucket < evaluation_end)
    session.execute(delete(MetricAnomaly).where(*filters))


def _recalculate_project_metric_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    settings: AnomalyDetectionSettings,
    overrides: ScopeOverrides | None = None,
    evaluation_start: datetime,
    evaluation_end: datetime,
    covered_buckets: set[datetime] | None = None,
    settling_delay: timedelta = NO_INGESTION_SETTLING,
) -> int:
    """Detect anomalies over the project's active catalog metric series.

    Metric anomalies are project-global: stored with ``scope_type='metric'``,
    ``scope_ref=str(metric_definition_id)`` and a NULL ``scan_config_id``.
    Count-shaped metrics keep the standard zero-fill + ``min_expected_count``
    behavior; fractional metrics (ratios/averages/sql) drop both so sparse or
    sub-unit series do not produce false anomalies.

    ``evaluation_start`` arrives on the SCAN CONFIG's grid; each metric widens it
    onto its own grid (see ``ANOMALY_TRAILING_REEVAL_BUCKETS``). Widening only —
    a replay hands in a window wider than any metric's trailing sweep and keeps
    it, so a replayed range is still re-scored end to end.
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
        # The scope override lands FIRST, so a fractional metric still drops the
        # count gate afterwards: ratcheting a ratio's min_expected_count would
        # re-introduce exactly the volume gate tripl-68bc removed for it. Its
        # sigma ratchet still applies.
        scoped = _scope_settings(settings, overrides or {}, SCOPE_METRIC, str(metric.id))
        metric_settings = (
            scoped
            if count_shaped
            else replace(scoped, min_expected_count=_FRACTIONAL_MIN_EXPECTED_COUNT)
        )
        metric_evaluation_start = min(
            evaluation_start,
            evaluation_end - interval_spec.delta * ANOMALY_TRAILING_REEVAL_BUCKETS,
        )
        history_from = metric_evaluation_start - interval_spec.delta * required_history_buckets(
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
            evaluation_start=metric_evaluation_start,
            evaluation_end=evaluation_end,
            event_id=None,
            event_type_id=None,
            anomalies=detect_anomalies(
                points,
                interval=interval_spec.delta,
                evaluation_start=metric_evaluation_start,
                evaluation_end=evaluation_end,
                settings=metric_settings,
                fill_gaps=count_shaped,
                covered_buckets=covered_buckets,
                # Per-metric grid: a 1d ratio needs a whole bucket withheld for
                # the same allowance that withholds two hourly ones.
                settling_buckets=settling_buckets_for(interval_spec.delta, settling_delay),
            ),
        )
    return detected


def _age_out_config_anomalies(
    session: Session,
    model: type[MetricAnomaly] | type[MetricBreakdownAnomaly],
    scan_config_id: uuid.UUID,
) -> None:
    """Trim config-scoped anomaly markers older than the retention horizon.

    Conservative: only touches rows keyed to THIS scan_config (never the shared
    ``metric``-scope NULL-config rows) and only those far past the horizon, so a
    trailing re-eval never resurrects long-dead dots as active markers.
    """
    horizon = datetime.now(UTC) - timedelta(days=ANOMALY_RETENTION_DAYS)
    session.execute(
        delete(model).where(model.scan_config_id == scan_config_id, model.bucket < horizon)
    )


def _recalculate_metric_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    evaluation_start: datetime,
    evaluation_end: datetime,
    covered_buckets: set[datetime] | None = None,
    settling_delay: timedelta = NO_INGESTION_SETTLING,
) -> int:
    project_settings = _get_project_anomaly_settings(session, config.project_id)
    if project_settings is None or not project_settings.anomaly_detection_enabled:
        session.execute(delete(MetricAnomaly).where(MetricAnomaly.scan_config_id == config.id))
        _purge_project_metric_anomalies(session, config)
        session.flush()
        return 0

    if not config.interval:
        return 0

    _age_out_config_anomalies(session, MetricAnomaly, config.id)

    interval_spec = get_interval(config.interval)
    settings = _build_anomaly_settings(project_settings)
    overrides = _load_scope_overrides(
        session,
        project_id=config.project_id,
        scan_config_id=config.id,
    )
    # Buckets at the head of the window that the warehouse may still be filling.
    # They stay in the loaded series (so baselines are complete) but no anomaly
    # is emitted for them until a later scan re-evaluates them (tripl-jfm3.7).
    settling_buckets = settling_buckets_for(interval_spec.delta, settling_delay)
    # History depth is driven by the baseline/min-history buckets, which no
    # override touches, so one window serves every scope.
    history_from = evaluation_start - interval_spec.delta * required_history_buckets(
        interval_spec.delta, settings
    )
    anomalies_detected = 0

    if project_settings.detect_project_total:
        total_settings = _scope_settings(settings, overrides, SCOPE_PROJECT_TOTAL, str(config.id))
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
                settings=total_settings,
                covered_buckets=covered_buckets,
                settling_buckets=settling_buckets,
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
        type_max_counts = _scope_max_counts(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_EVENT_TYPE,
            history_from=history_from,
            time_to=evaluation_end,
        )
        for event_type_id in _collect_scope_ids(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT_TYPE,
        ):
            scope_ref = str(event_type_id)
            scope_settings = _scope_settings(settings, overrides, SCOPE_EVENT_TYPE, scope_ref)
            # Provably silent (tripl-h353): the detector would early-exit on
            # this series anyway, so skip loading its history — but still run
            # the replace with no anomalies so stale window rows age out.
            if is_provably_silent(
                type_max_counts.get(event_type_id, 0.0), scope_settings.min_expected_count
            ):
                anomalies_detected += _replace_scope_anomalies(
                    session,
                    scan_config_id=config.id,
                    scope_type=SCOPE_EVENT_TYPE,
                    scope_ref=scope_ref,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    event_id=None,
                    event_type_id=event_type_id,
                    anomalies=[],
                )
                continue
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
                    settings=scope_settings,
                    covered_buckets=covered_buckets,
                    settling_buckets=settling_buckets,
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
        event_max_counts = _scope_max_counts(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_EVENT,
            history_from=history_from,
            time_to=evaluation_end,
        )
        for event_id in _collect_scope_ids(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT,
        ):
            scope_ref = str(event_id)
            scope_settings = _scope_settings(settings, overrides, SCOPE_EVENT, scope_ref)
            # Provably silent (tripl-h353): see the event-type loop above.
            if is_provably_silent(
                event_max_counts.get(event_id, 0.0), scope_settings.min_expected_count
            ):
                anomalies_detected += _replace_scope_anomalies(
                    session,
                    scan_config_id=config.id,
                    scope_type=SCOPE_EVENT,
                    scope_ref=scope_ref,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    event_id=event_id,
                    event_type_id=None,
                    anomalies=[],
                )
                continue
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
                    settings=scope_settings,
                    covered_buckets=covered_buckets,
                    settling_buckets=settling_buckets,
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
            overrides=overrides,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            covered_buckets=covered_buckets,
            settling_delay=settling_delay,
        )
    else:
        _purge_project_metric_anomalies(session, config, evaluation_end=evaluation_end)

    session.flush()
    return anomalies_detected


# A platform-parity ratio needs a genuine two-platform history before the
# comparison says anything. Five non-zero buckets is deliberately low: it clears
# platform-exclusive events (whose ratio is zero almost everywhere) without
# muting a real platform that merely has quiet hours (tripl-jfm3.96).
_PARITY_MIN_NONZERO_BUCKETS = 5


def _recalculate_platform_parity_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    project_settings: ProjectAnomalySettings,
    settings: AnomalyDetectionSettings,
    evaluation_start: datetime,
    evaluation_end: datetime,
    covered_buckets: set[datetime] | None = None,
    settling_delay: timedelta = NO_INGESTION_SETTLING,
) -> int:
    platform_column = config.platform_column
    if not platform_column or not config.interval:
        session.execute(
            delete(MetricBreakdownAnomaly).where(
                MetricBreakdownAnomaly.scan_config_id == config.id,
                MetricBreakdownAnomaly.kind == MetricBreakdownAnomalyKind.parity,
            )
        )
        return 0

    session.execute(
        delete(MetricBreakdownAnomaly).where(
            MetricBreakdownAnomaly.scan_config_id == config.id,
            MetricBreakdownAnomaly.kind == MetricBreakdownAnomalyKind.parity,
            MetricBreakdownAnomaly.breakdown_column != platform_column,
        )
    )

    interval_spec = get_interval(config.interval)
    ratio_settings = replace(settings, min_expected_count=0)
    settling_buckets = settling_buckets_for(interval_spec.delta, settling_delay)
    history_from = evaluation_start - interval_spec.delta * required_history_buckets(
        interval_spec.delta, ratio_settings
    )
    detected = 0

    scope_settings = (
        (SCOPE_PROJECT_TOTAL, project_settings.detect_project_total),
        (SCOPE_EVENT_TYPE, project_settings.detect_event_types),
        (SCOPE_EVENT, project_settings.detect_events),
    )
    for scope_type, enabled in scope_settings:
        if not enabled:
            session.execute(
                delete(MetricBreakdownAnomaly).where(
                    MetricBreakdownAnomaly.scan_config_id == config.id,
                    MetricBreakdownAnomaly.scope_type == scope_type,
                    MetricBreakdownAnomaly.kind == MetricBreakdownAnomalyKind.parity,
                    MetricBreakdownAnomaly.bucket >= evaluation_start,
                    MetricBreakdownAnomaly.bucket < evaluation_end,
                )
            )
            continue

        keys = _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=scope_type,
            kind=MetricBreakdownAnomalyKind.parity,
        )
        # One scope's total series is shared by all of its platform values.
        totals_by_scope: dict[str, list[SeriesPoint]] = {}
        for event_id, event_type_id, column, value, is_other in keys:
            if column != platform_column:
                continue
            if scope_type == SCOPE_PROJECT_TOTAL:
                scope_ref = str(config.id)
                stored_event_id = None
                stored_event_type_id = None
            elif scope_type == SCOPE_EVENT_TYPE:
                if event_type_id is None:
                    continue
                scope_ref = str(event_type_id)
                stored_event_id = None
                stored_event_type_id = event_type_id
            else:
                if event_id is None:
                    continue
                scope_ref = str(event_id)
                stored_event_id = event_id
                stored_event_type_id = None

            total_points = totals_by_scope.get(scope_ref)
            if total_points is None:
                total_points = _load_scope_points(
                    session,
                    scan_config_id=config.id,
                    scope_type=scope_type,
                    scope_ref=scope_ref,
                    history_from=history_from,
                    time_to=evaluation_end,
                )
                totals_by_scope[scope_ref] = total_points
            points = _load_platform_ratio_points(
                session,
                scan_config_id=config.id,
                scope_type=scope_type,
                scope_ref=scope_ref,
                breakdown_column=platform_column,
                breakdown_value=value,
                is_other=is_other,
                history_from=history_from,
                time_to=evaluation_end,
                covered_buckets=covered_buckets,
                total_points=total_points,
            )
            # A parity ratio that is zero in most buckets is a platform-EXCLUSIVE
            # event, not a platform imbalance. Scoring it flagged every bucket
            # where the other platform emitted even once: the ratio path runs at
            # min_expected_count=0 by design, so no volume gate stops it, and a
            # near-zero baseline made the deviation look enormous
            # (tripl-jfm3.96). Require a real two-platform history before the
            # comparison means anything.
            if sum(1 for point in points if point.count) < _PARITY_MIN_NONZERO_BUCKETS:
                continue
            detected += _replace_scope_breakdown_anomalies(
                session,
                scan_config_id=config.id,
                scope_type=scope_type,
                scope_ref=scope_ref,
                breakdown_column=platform_column,
                breakdown_value=value,
                is_other=is_other,
                evaluation_start=evaluation_start,
                evaluation_end=evaluation_end,
                event_id=stored_event_id,
                event_type_id=stored_event_type_id,
                anomalies=detect_anomalies(
                    points,
                    interval=interval_spec.delta,
                    evaluation_start=evaluation_start,
                    evaluation_end=evaluation_end,
                    settings=ratio_settings,
                    fill_gaps=False,
                    settling_buckets=settling_buckets,
                ),
                kind=MetricBreakdownAnomalyKind.parity,
            )
    return detected


def _recalculate_metric_breakdown_anomalies(
    session: Session,
    config: ScanConfig,
    *,
    evaluation_start: datetime,
    evaluation_end: datetime,
    covered_buckets: set[datetime] | None = None,
    settling_delay: timedelta = NO_INGESTION_SETTLING,
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
        and not config.platform_column
        and not _scan_has_event_level_breakdown_columns(session, config.id)
    ):
        session.execute(
            delete(MetricBreakdownAnomaly).where(MetricBreakdownAnomaly.scan_config_id == config.id)
        )
        session.flush()
        return 0

    _age_out_config_anomalies(session, MetricBreakdownAnomaly, config.id)

    interval_spec = get_interval(config.interval)
    settings = _build_anomaly_settings(project_settings)
    settling_buckets = settling_buckets_for(interval_spec.delta, settling_delay)
    app_version_column = config.app_version_column
    if app_version_column:
        # Clear markers produced before app-version series became observational.
        # Keep parity rows (platform-only) and the raw breakdown metrics used by
        # adoption charts and the dedicated release-regression detector.
        session.execute(
            delete(MetricBreakdownAnomaly).where(
                MetricBreakdownAnomaly.scan_config_id == config.id,
                MetricBreakdownAnomaly.breakdown_column == app_version_column,
                MetricBreakdownAnomaly.kind == MetricBreakdownAnomalyKind.volume,
            )
        )
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
            app_version_column=app_version_column,
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
                    covered_buckets=covered_buckets,
                    settling_buckets=settling_buckets,
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
        type_breakdown_max = _breakdown_scope_max_counts(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_EVENT_TYPE,
            history_from=history_from,
            time_to=evaluation_end,
        )
        for _event_id, event_type_id, column, value, is_other in _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT_TYPE,
            app_version_column=app_version_column,
        ):
            if event_type_id is None:
                continue
            scope_ref = str(event_type_id)
            # Provably silent (tripl-h353, extended to breakdowns in tripl-jfm3.73):
            # the detector would early-exit on this series anyway, so skip loading
            # its history — but still run the replace with no anomalies so stale
            # window rows age out.
            if is_provably_silent(
                type_breakdown_max.get((event_type_id, column, value, is_other), 0.0),
                settings.min_expected_count,
            ):
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
                    anomalies=[],
                )
                continue
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
                    covered_buckets=covered_buckets,
                    settling_buckets=settling_buckets,
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
        event_breakdown_max = _breakdown_scope_max_counts(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_EVENT,
            history_from=history_from,
            time_to=evaluation_end,
        )
        for event_id, _event_type_id, column, value, is_other in _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=history_from,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            scope_type=SCOPE_EVENT,
            app_version_column=app_version_column,
        ):
            if event_id is None:
                continue
            scope_ref = str(event_id)
            # Provably silent (see the event-type loop above).
            if is_provably_silent(
                event_breakdown_max.get((event_id, column, value, is_other), 0.0),
                settings.min_expected_count,
            ):
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
                    anomalies=[],
                )
                continue
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
                    covered_buckets=covered_buckets,
                    settling_buckets=settling_buckets,
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

    anomalies_detected += _recalculate_platform_parity_anomalies(
        session,
        config,
        project_settings=project_settings,
        settings=settings,
        evaluation_start=evaluation_start,
        evaluation_end=evaluation_end,
        covered_buckets=covered_buckets,
        settling_delay=settling_delay,
    )

    session.flush()
    return anomalies_detected
