"""Service for querying event metrics and anomaly signals from PostgreSQL."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
    SeriesPoint,
    expand_series,
    forecast_next_buckets,
)
from tripl.core.intervals import get_interval
from tripl.models.domain_enums import MetricBreakdownAnomalyKind
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_tag import EventTag
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.project import Project
from tripl.models.release_regression import ReleaseRegression
from tripl.models.scan_config import ScanConfig
from tripl.schemas.data_source import DataSourceStatsResponse, DataSourceThroughputPoint
from tripl.schemas.event_metric import (
    AppVersionAdoptionResponse,
    AppVersionInfo,
    AppVersionMetricSeries,
    AppVersionSeriesResponse,
    BreakdownTimelinePoint,
    EventMetricBreakdownSeries,
    EventMetricBreakdownsResponse,
    EventMetricPoint,
    EventMetricsResponse,
    EventWindowMetricsResponse,
    ForecastPoint,
    MetricSignalResponse,
    OverviewKpiSeriesResponse,
    PlatformParityAnomaly,
    PlatformPresenceResponse,
    PlatformPresenceRow,
    ReleaseRegressionItem,
    ReleaseRegressionsResponse,
    TopEventResponse,
)
from tripl.semver import (
    APP_VERSION_OTHER_LABEL,
    order_versions,
)
from tripl.services.monitoring_utils import classify_signal_state
from tripl.services.project_lookup import get_project_by_slug
from tripl.services.version_activation import (
    DEFAULT_ACTIVE_SHARE_MIN,
    active_release_versions,
    compile_prerelease_pattern,
    released_versions,
    resolve_share_min,
)


async def _resolve_project(session: AsyncSession, slug: str) -> Project:
    return await get_project_by_slug(session, slug, detail=f"Project '{slug}' not found")


async def _resolve_event(
    session: AsyncSession,
    project_id: uuid.UUID,
    event_id: uuid.UUID,
) -> Event:
    event = await session.get(Event, event_id)
    if event is None or event.project_id != project_id:
        raise HTTPException(404, "Event not found")
    return event


async def _resolve_event_type(
    session: AsyncSession,
    project_id: uuid.UUID,
    event_type_id: uuid.UUID,
) -> EventType:
    event_type = await session.get(EventType, event_type_id)
    if event_type is None or event_type.project_id != project_id:
        raise HTTPException(404, "Event type not found")
    return event_type


async def _resolve_scan_config(
    session: AsyncSession,
    project_id: uuid.UUID,
    scan_config_id: uuid.UUID,
) -> ScanConfig:
    config = await session.get(ScanConfig, scan_config_id)
    if config is None or config.project_id != project_id:
        raise HTTPException(404, "Scan config not found")
    return config


async def _get_scan_config_interval(
    session: AsyncSession,
    scan_config_id: uuid.UUID | None,
) -> str | None:
    if scan_config_id is None:
        return None
    result = await session.execute(
        select(ScanConfig.interval).where(ScanConfig.id == scan_config_id)
    )
    return result.scalar_one_or_none()


async def _get_scan_config_sigma_threshold(
    session: AsyncSession,
    scan_config_id: uuid.UUID | None,
) -> float:
    """The scan's anomaly sigma threshold (the confidence-band multiplier the UI
    serves), defaulting to 3.0 when the scan is unknown or unset."""
    if scan_config_id is None:
        return 3.0
    result = await session.execute(
        select(ScanConfig.sigma_threshold).where(ScanConfig.id == scan_config_id)
    )
    return result.scalar_one_or_none() or 3.0


async def _get_default_scan_config_id(
    session: AsyncSession,
    project_id: uuid.UUID,
) -> uuid.UUID | None:
    result = await session.execute(
        select(ScanConfig.id)
        .where(
            ScanConfig.project_id == project_id,
            ScanConfig.interval.isnot(None),
            ScanConfig.time_column.isnot(None),
        )
        .order_by(ScanConfig.updated_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _resolve_scope_scan_config_id(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    event_id: uuid.UUID | None = None,
    event_type_id: uuid.UUID | None = None,
) -> uuid.UUID | None:
    metric_query = (
        select(EventMetric.scan_config_id, EventMetric.bucket)
        .join(ScanConfig, ScanConfig.id == EventMetric.scan_config_id)
        .where(ScanConfig.project_id == project_id)
    )
    anomaly_query = (
        select(MetricAnomaly.scan_config_id, MetricAnomaly.bucket)
        .join(ScanConfig, ScanConfig.id == MetricAnomaly.scan_config_id)
        .where(ScanConfig.project_id == project_id)
    )

    if event_id is not None:
        metric_query = metric_query.where(EventMetric.event_id == event_id)
        anomaly_query = anomaly_query.where(MetricAnomaly.event_id == event_id)
    elif event_type_id is not None:
        metric_query = metric_query.where(
            EventMetric.event_id.is_(None),
            EventMetric.event_type_id == event_type_id,
        )
        anomaly_query = anomaly_query.where(MetricAnomaly.event_type_id == event_type_id)
    else:
        return await _get_default_scan_config_id(session, project_id)

    metric_row = (
        await session.execute(metric_query.order_by(EventMetric.bucket.desc()).limit(1))
    ).first()
    anomaly_row = (
        await session.execute(anomaly_query.order_by(MetricAnomaly.bucket.desc()).limit(1))
    ).first()

    candidates: list[tuple[uuid.UUID, datetime]] = []
    if metric_row is not None:
        candidates.append((metric_row[0], metric_row[1]))
    if anomaly_row is not None:
        candidates.append((anomaly_row[0], anomaly_row[1]))
    if not candidates:
        return await _get_default_scan_config_id(session, project_id)

    scan_config_id, _bucket = max(candidates, key=lambda row: row[1])
    return scan_config_id


async def _get_metric_rows(
    session: AsyncSession,
    *,
    scope: str,
    scan_config_id: uuid.UUID,
    scope_ref: str,
    time_from: datetime | None,
    time_to: datetime | None,
) -> list[tuple[datetime, int]]:
    if scope == SCOPE_PROJECT_TOTAL:
        query = (
            select(EventMetric.bucket, func.sum(EventMetric.count))
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id.is_not(None),
            )
            .group_by(EventMetric.bucket)
            .order_by(EventMetric.bucket)
        )
    elif scope == SCOPE_EVENT_TYPE:
        query = (
            select(EventMetric.bucket, EventMetric.count)
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id == uuid.UUID(scope_ref),
            )
            .order_by(EventMetric.bucket)
        )
    else:
        query = (
            select(EventMetric.bucket, EventMetric.count)
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id == uuid.UUID(scope_ref),
            )
            .order_by(EventMetric.bucket)
        )

    if time_from is not None:
        query = query.where(EventMetric.bucket >= time_from)
    if time_to is not None:
        query = query.where(EventMetric.bucket < time_to)

    result = await session.execute(query)
    return [(bucket, int(count)) for bucket, count in result.all()]


async def _get_anomaly_rows(
    session: AsyncSession,
    *,
    scan_config_id: uuid.UUID,
    scope: str,
    scope_ref: str,
    time_from: datetime | None,
    time_to: datetime | None,
) -> list[MetricAnomaly]:
    query = (
        select(MetricAnomaly)
        .where(
            MetricAnomaly.scan_config_id == scan_config_id,
            MetricAnomaly.scope_type == scope,
            MetricAnomaly.scope_ref == scope_ref,
        )
        .order_by(MetricAnomaly.bucket)
    )
    if time_from is not None:
        query = query.where(MetricAnomaly.bucket >= time_from)
    if time_to is not None:
        query = query.where(MetricAnomaly.bucket < time_to)

    result = await session.execute(query)
    return list(result.scalars().all())


def _signal_from_anomaly(
    anomaly: MetricAnomaly,
    *,
    state: str,
) -> MetricSignalResponse:
    return MetricSignalResponse(
        scan_config_id=anomaly.scan_config_id,
        scope_type=anomaly.scope_type,
        scope_ref=anomaly.scope_ref,
        state=state,
        event_id=anomaly.event_id,
        event_type_id=anomaly.event_type_id,
        bucket=anomaly.bucket,
        actual_count=anomaly.actual_count,
        expected_count=anomaly.expected_count,
        stddev=anomaly.stddev,
        z_score=anomaly.z_score,
        direction=anomaly.direction,
    )


def _served_stddev(anomaly: MetricAnomaly | MetricBreakdownAnomaly) -> float:
    """Stddev the UI band is drawn from: the FLOORED *effective* stddev actually
    used in the z denominator (tripl-dmch C3/C4), so ``expected ± k*stddev``
    matches the detector's flag decision. Falls back to the raw stored stddev
    when the ``effective_stddev`` column is absent (pre-migration rows / hand-
    built test objects), keeping existing behavior unchanged in that case.
    """
    effective = getattr(anomaly, "effective_stddev", None)
    if effective is None or effective == 0.0:
        return anomaly.stddev
    return float(effective)


def _served_detector_kind(anomaly: MetricAnomaly | MetricBreakdownAnomaly) -> str | None:
    """Which detector path flagged the bucket, or ``None`` when the column is
    absent (pre-migration rows / hand-built test objects)."""
    return getattr(anomaly, "detector_kind", None)


def _build_metric_points(
    *,
    interval: str | None,
    metric_rows: list[tuple[datetime, int]],
    anomalies: list[MetricAnomaly] | list[MetricBreakdownAnomaly],
) -> list[EventMetricPoint]:
    counts_by_bucket = {bucket: count for bucket, count in metric_rows}
    anomalies_by_bucket = {anomaly.bucket: anomaly for anomaly in anomalies}

    for anomaly in anomalies:
        # Event-scope actuals are whole counts stored in a float column; round
        # keeps the int-typed volume series exact (catalog-metric series render
        # through metric_series_service, not this builder).
        counts_by_bucket.setdefault(anomaly.bucket, round(anomaly.actual_count))

    if interval and counts_by_bucket:
        delta = get_interval(interval).delta
        expanded = expand_series(
            [
                SeriesPoint(bucket=bucket, count=count)
                for bucket, count in sorted(counts_by_bucket.items())
            ],
            interval=delta,
            end_exclusive=max(counts_by_bucket) + delta,
        )
        data = [
            EventMetricPoint(
                bucket=point.bucket,
                count=point.count,
                expected_count=(
                    anomalies_by_bucket[point.bucket].expected_count
                    if point.bucket in anomalies_by_bucket
                    else None
                ),
                stddev=(
                    _served_stddev(anomalies_by_bucket[point.bucket])
                    if point.bucket in anomalies_by_bucket
                    else None
                ),
                detector_kind=(
                    _served_detector_kind(anomalies_by_bucket[point.bucket])
                    if point.bucket in anomalies_by_bucket
                    else None
                ),
                is_anomaly=point.bucket in anomalies_by_bucket,
                anomaly_direction=(
                    anomalies_by_bucket[point.bucket].direction
                    if point.bucket in anomalies_by_bucket
                    else None
                ),
                z_score=(
                    anomalies_by_bucket[point.bucket].z_score
                    if point.bucket in anomalies_by_bucket
                    else None
                ),
            )
            for point in expanded
        ]
    else:
        data = [
            EventMetricPoint(
                bucket=bucket,
                count=count,
                expected_count=(
                    anomalies_by_bucket[bucket].expected_count
                    if bucket in anomalies_by_bucket
                    else None
                ),
                stddev=(
                    _served_stddev(anomalies_by_bucket[bucket])
                    if bucket in anomalies_by_bucket
                    else None
                ),
                detector_kind=(
                    _served_detector_kind(anomalies_by_bucket[bucket])
                    if bucket in anomalies_by_bucket
                    else None
                ),
                is_anomaly=bucket in anomalies_by_bucket,
                anomaly_direction=(
                    anomalies_by_bucket[bucket].direction if bucket in anomalies_by_bucket else None
                ),
                z_score=(
                    anomalies_by_bucket[bucket].z_score if bucket in anomalies_by_bucket else None
                ),
            )
            for bucket, count in sorted(counts_by_bucket.items())
        ]

    return data


def _forecast_from_points(
    *,
    data: list[EventMetricPoint],
    interval: str | None,
) -> list[ForecastPoint]:
    """One-step-ahead forecast off the densified series the chart already shows.

    Returns an empty list when the series is too short to fit STL/MSTL — the
    UI then simply omits the dashed preview rather than drawing a flat line.
    """
    if not data or not interval:
        return []
    delta = get_interval(interval).delta
    series_points = [SeriesPoint(bucket=point.bucket, count=point.count) for point in data]
    forecasted = forecast_next_buckets(series_points, interval=delta, horizon=1)
    return [
        ForecastPoint(
            bucket=point.bucket,
            expected_count=point.expected_count,
            stddev=point.stddev,
        )
        for point in forecasted
    ]


def _build_metrics_response(
    *,
    scope: str,
    scan_config_id: uuid.UUID | None,
    scope_ref: str | None,
    interval: str | None,
    metric_rows: list[tuple[datetime, int]],
    anomalies: list[MetricAnomaly],
    event_id: uuid.UUID | None = None,
    event_type_id: uuid.UUID | None = None,
    sigma_threshold: float = 3.0,
) -> EventMetricsResponse:
    data = _build_metric_points(
        interval=interval,
        metric_rows=metric_rows,
        anomalies=anomalies,
    )
    latest_signal = None
    latest_metric_bucket = data[-1].bucket if data else None
    if anomalies:
        latest_anomaly = anomalies[-1]
        state = classify_signal_state(
            anomaly_bucket=latest_anomaly.bucket,
            latest_metric_bucket=latest_metric_bucket,
        )
        if state is not None:
            latest_signal = _signal_from_anomaly(latest_anomaly, state=state)

    return EventMetricsResponse(
        scope=scope,
        scan_config_id=scan_config_id,
        event_id=event_id,
        event_type_id=event_type_id,
        interval=interval,
        latest_signal=latest_signal,
        sigma_threshold=sigma_threshold,
        data=data,
        forecast=_forecast_from_points(data=data, interval=interval),
    )


async def get_event_metrics(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> EventMetricsResponse:
    project = await _resolve_project(session, slug)
    event = await _resolve_event(session, project.id, event_id)
    scan_config_id = await _resolve_scope_scan_config_id(
        session,
        project.id,
        event_id=event.id,
    )
    interval = await _get_scan_config_interval(session, scan_config_id)
    if scan_config_id is None:
        return EventMetricsResponse(
            scope=SCOPE_EVENT,
            event_id=event.id,
            interval=interval,
            data=[],
        )

    metric_rows = await _get_metric_rows(
        session,
        scope=SCOPE_EVENT,
        scan_config_id=scan_config_id,
        scope_ref=str(event.id),
        time_from=time_from,
        time_to=time_to,
    )
    anomalies = await _get_anomaly_rows(
        session,
        scan_config_id=scan_config_id,
        scope=SCOPE_EVENT,
        scope_ref=str(event.id),
        time_from=time_from,
        time_to=time_to,
    )
    sigma_threshold = await _get_scan_config_sigma_threshold(session, scan_config_id)
    return _build_metrics_response(
        scope=SCOPE_EVENT,
        scan_config_id=scan_config_id,
        scope_ref=str(event.id),
        interval=interval,
        metric_rows=metric_rows,
        anomalies=anomalies,
        event_id=event.id,
        sigma_threshold=sigma_threshold,
    )


async def get_event_metric_breakdowns(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    column: str | None = None,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> EventMetricBreakdownsResponse:
    project = await _resolve_project(session, slug)
    event = await _resolve_event(session, project.id, event_id)
    scan_config_id = await _resolve_scope_scan_config_id(
        session,
        project.id,
        event_id=event.id,
    )
    event_columns = list(dict.fromkeys(event.metric_breakdown_columns or []))
    if scan_config_id is None:
        if column is not None and column not in event_columns:
            raise HTTPException(400, "Breakdown column is not configured for this event")
        return EventMetricBreakdownsResponse(
            event_id=event.id,
            columns=event_columns,
            selected_column=column if column in event_columns else None,
            series=[],
        )

    config = await session.get(ScanConfig, scan_config_id)
    if config is None or config.project_id != project.id:
        if column is not None and column not in event_columns:
            raise HTTPException(400, "Breakdown column is not configured for this event")
        return EventMetricBreakdownsResponse(
            event_id=event.id,
            columns=event_columns,
            selected_column=column if column in event_columns else None,
            series=[],
        )

    columns = list(dict.fromkeys([*(config.metric_breakdown_columns or []), *event_columns]))
    if not columns:
        return EventMetricBreakdownsResponse(
            event_id=event.id,
            scan_config_id=scan_config_id,
            interval=config.interval,
            columns=[],
            series=[],
        )

    if column is not None and column not in columns:
        raise HTTPException(400, "Breakdown column is not configured for this event")

    selected_column = column
    if selected_column is None:
        data_column_query = select(EventMetricBreakdown.breakdown_column).where(
            EventMetricBreakdown.scan_config_id == scan_config_id,
            EventMetricBreakdown.event_id == event.id,
        )
        if time_from is not None:
            data_column_query = data_column_query.where(EventMetricBreakdown.bucket >= time_from)
        if time_to is not None:
            data_column_query = data_column_query.where(EventMetricBreakdown.bucket < time_to)
        data_columns = set((await session.execute(data_column_query.distinct())).scalars())
        selected_column = next((item for item in columns if item in data_columns), columns[0])

    metric_query = (
        select(
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            EventMetricBreakdown.bucket,
            func.sum(EventMetricBreakdown.count),
        )
        .where(
            EventMetricBreakdown.scan_config_id == scan_config_id,
            EventMetricBreakdown.event_id == event.id,
            EventMetricBreakdown.breakdown_column == selected_column,
        )
        .group_by(
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            EventMetricBreakdown.bucket,
        )
        .order_by(EventMetricBreakdown.breakdown_value, EventMetricBreakdown.bucket)
    )
    if time_from is not None:
        metric_query = metric_query.where(EventMetricBreakdown.bucket >= time_from)
    if time_to is not None:
        metric_query = metric_query.where(EventMetricBreakdown.bucket < time_to)

    metric_rows_by_series: dict[tuple[str, bool], list[tuple[datetime, int]]] = {}
    for value, is_other, bucket, count in (await session.execute(metric_query)).all():
        key = (value, bool(is_other))
        metric_rows_by_series.setdefault(key, []).append((bucket, int(count)))

    anomaly_query = (
        select(MetricBreakdownAnomaly)
        .where(
            MetricBreakdownAnomaly.scan_config_id == scan_config_id,
            MetricBreakdownAnomaly.scope_type == SCOPE_EVENT,
            MetricBreakdownAnomaly.event_id == event.id,
            MetricBreakdownAnomaly.breakdown_column == selected_column,
        )
        .order_by(MetricBreakdownAnomaly.breakdown_value, MetricBreakdownAnomaly.bucket)
    )
    if time_from is not None:
        anomaly_query = anomaly_query.where(MetricBreakdownAnomaly.bucket >= time_from)
    if time_to is not None:
        anomaly_query = anomaly_query.where(MetricBreakdownAnomaly.bucket < time_to)

    anomalies_by_series: dict[tuple[str, bool], list[MetricBreakdownAnomaly]] = {}
    parity_by_series: dict[tuple[str, bool], list[MetricBreakdownAnomaly]] = {}
    for anomaly in (await session.execute(anomaly_query)).scalars():
        key = (anomaly.breakdown_value, anomaly.is_other)
        target = (
            parity_by_series
            if anomaly.kind == MetricBreakdownAnomalyKind.parity
            else anomalies_by_series
        )
        target.setdefault(key, []).append(anomaly)

    series: list[EventMetricBreakdownSeries] = []
    for key in set(metric_rows_by_series) | set(anomalies_by_series) | set(parity_by_series):
        value, is_other = key
        data = _build_metric_points(
            interval=config.interval,
            metric_rows=metric_rows_by_series.get(key, []),
            anomalies=anomalies_by_series.get(key, []),
        )
        series.append(
            EventMetricBreakdownSeries(
                breakdown_value=value,
                is_other=is_other,
                total_count=sum(point.count for point in data),
                data=data,
                parity_anomalies=[
                    PlatformParityAnomaly(
                        bucket=anomaly.bucket,
                        actual_share=anomaly.actual_count,
                        expected_share=anomaly.expected_count,
                        stddev=anomaly.stddev,
                        z_score=anomaly.z_score,
                        direction=anomaly.direction,
                    )
                    for anomaly in parity_by_series.get(key, [])
                ],
            )
        )

    series.sort(key=lambda item: (item.is_other, -item.total_count, item.breakdown_value))
    return EventMetricBreakdownsResponse(
        event_id=event.id,
        scan_config_id=scan_config_id,
        interval=config.interval,
        columns=columns,
        selected_column=selected_column,
        series=series,
    )


def _validate_app_version_scope_ref(
    *,
    scope_type: str,
    scope_ref: str | None,
    scan_config_id: uuid.UUID,
) -> str:
    if scope_type == SCOPE_PROJECT_TOTAL:
        return str(scan_config_id)
    if scope_type in {SCOPE_EVENT_TYPE, SCOPE_EVENT}:
        if not scope_ref:
            raise HTTPException(400, "scope_ref is required for event and event_type scopes")
        try:
            return str(uuid.UUID(scope_ref))
        except ValueError as exc:
            raise HTTPException(400, "scope_ref must be a UUID") from exc
    raise HTTPException(400, "scope_type must be project_total, event_type, or event")


async def _resolve_app_version_scope(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    if scope_type == SCOPE_EVENT:
        event = await _resolve_event(session, project_id, uuid.UUID(scope_ref))
        return event.id, None
    if scope_type == SCOPE_EVENT_TYPE:
        event_type = await _resolve_event_type(session, project_id, uuid.UUID(scope_ref))
        return None, event_type.id
    return None, None


def _order_app_version_keys(keys: set[tuple[str, bool]]) -> list[tuple[str, bool]]:
    explicit_versions = {version for version, is_other in keys if not is_other}
    ordered = [(version, False) for version in order_versions(explicit_versions, reverse=True)]
    other_versions = sorted((version, is_other) for version, is_other in keys if is_other)
    return ordered + other_versions


def _latest_app_version(
    keys: set[tuple[str, bool]], released: set[str] | None = None
) -> str | None:
    explicit_versions = {version for version, is_other in keys if not is_other}
    if released is not None:
        explicit_versions &= released
    ordered = order_versions(explicit_versions, reverse=True)
    return ordered[0] if ordered else None


def _retained_versions(
    explicit_versions: set[str],
    active_versions: set[str],
    keep_releases: int,
    *,
    released: set[str] | None = None,
) -> set[str]:
    """Latest ``keep_releases`` versions, prioritizing released, active versions.

    Retention slots are filled in priority order: released activated releases
    (newest first), then released-but-inactive, then prerelease/dev builds. This
    stops a higher-SemVer dev/tester build that never took real traffic — or a
    SemVer-prerelease build — from occupying a retention slot ahead of a shipped
    release (which would otherwise fold that release into "Other"). ``released``
    defaults to "everything is released", degrading to the prior active-first
    SemVer top-N and matching the previous behavior.
    """
    if keep_releases <= 0:
        return set()
    ordered = order_versions(explicit_versions, reverse=True)
    released_set = released if released is not None else set(explicit_versions)
    released_active = [v for v in ordered if v in released_set and v in active_versions]
    released_inactive = [v for v in ordered if v in released_set and v not in active_versions]
    prerelease = [v for v in ordered if v not in released_set]
    return set((released_active + released_inactive + prerelease)[:keep_releases])


async def _load_app_version_metric_rows(
    session: AsyncSession,
    *,
    config: ScanConfig,
    scope_type: str,
    event_id: uuid.UUID | None,
    event_type_id: uuid.UUID | None,
    time_from: datetime | None,
    time_to: datetime | None,
) -> dict[tuple[str, bool], list[tuple[datetime, int]]]:
    if config.app_version_column is None:
        return {}

    metric_query = (
        select(
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            EventMetricBreakdown.bucket,
            func.sum(EventMetricBreakdown.count),
        )
        .where(
            EventMetricBreakdown.scan_config_id == config.id,
            EventMetricBreakdown.breakdown_column == config.app_version_column,
        )
        .group_by(
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            EventMetricBreakdown.bucket,
        )
        .order_by(EventMetricBreakdown.bucket)
    )

    if scope_type == SCOPE_PROJECT_TOTAL:
        metric_query = metric_query.where(
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id.is_not(None),
        )
    elif scope_type == SCOPE_EVENT_TYPE:
        metric_query = metric_query.where(
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id == event_type_id,
        )
    else:
        metric_query = metric_query.where(EventMetricBreakdown.event_id == event_id)

    if time_from is not None:
        metric_query = metric_query.where(EventMetricBreakdown.bucket >= time_from)
    if time_to is not None:
        metric_query = metric_query.where(EventMetricBreakdown.bucket < time_to)

    metric_rows_by_series: dict[tuple[str, bool], list[tuple[datetime, int]]] = {}
    for version, is_other, bucket, count in (await session.execute(metric_query)).all():
        key = (str(version), bool(is_other))
        metric_rows_by_series.setdefault(key, []).append((bucket, int(count)))
    return metric_rows_by_series


def _build_app_version_series(
    *,
    interval: str | None,
    metric_rows_by_series: dict[tuple[str, bool], list[tuple[datetime, int]]],
    maturity_metric_rows_by_series: (
        dict[tuple[str, bool], list[tuple[datetime, int]]] | None
    ) = None,
    keep_releases: int,
    prerelease_pattern: re.Pattern[str] | None = None,
    share_min: float = DEFAULT_ACTIVE_SHARE_MIN,
) -> tuple[str | None, list[AppVersionInfo], list[AppVersionMetricSeries]]:
    # App-version curves are observational rollout/adoption views. They never
    # consume generic breakdown anomaly rows; release-specific failures are
    # represented by the dedicated ReleaseRegression model instead.
    # Retention is applied here, at read time, over every version present in the
    # requested window: keep the latest ``keep_releases`` versions — activated
    # releases first (see below) — as explicit series and roll the rest, plus any
    # legacy stored ``is_other`` rows, into a single "Other" series. Deciding the
    # kept set once over the whole window (rather than per collection chunk at
    # write time) stops a version from flipping in and out of "Other" between
    # chunks.
    explicit_versions = {version for version, is_other in metric_rows_by_series if not is_other}
    # Activation gate: a release can only be the "latest" — and can only hold a
    # retention slot ahead of an untried build — once it takes a real share of
    # project traffic. Event and event-type views supply their project's total
    # rows separately, so a rare event cannot make an otherwise mature release
    # look like a pre-release. Falling back keeps historical views usable until
    # a project-total row has been collected.
    maturity_rows_by_series = maturity_metric_rows_by_series or metric_rows_by_series
    release_totals_by_version: dict[str, dict[datetime, int]] = {}
    all_traffic_by_bucket: dict[datetime, int] = {}
    for (version, is_other), rows in maturity_rows_by_series.items():
        for bucket, count in rows:
            all_traffic_by_bucket[bucket] = all_traffic_by_bucket.get(bucket, 0) + count
            if not is_other:
                per_bucket = release_totals_by_version.setdefault(version, {})
                per_bucket[bucket] = per_bucket.get(bucket, 0) + count

    # Prerelease/dev builds (SemVer -tag by default, plus any per-scan pattern
    # match) are never eligible to be latest/active and never take a retention
    # slot ahead of a released version — but their series stays visible. Computing
    # ``active`` over only released versions keeps the denominator (all traffic)
    # intact while guaranteeing a prerelease is never marked active.
    released = released_versions(explicit_versions, prerelease_pattern=prerelease_pattern)
    maturity_released = released_versions(
        {version for version, is_other in maturity_rows_by_series if not is_other},
        prerelease_pattern=prerelease_pattern,
    )
    released_totals = {
        version: by_bucket
        for version, by_bucket in release_totals_by_version.items()
        if version in maturity_released
    }
    active_versions = (
        active_release_versions(released_totals, all_traffic_by_bucket, share_min=share_min)
        & explicit_versions
    )
    # Retain the latest ``keep_releases`` versions, released+active first, so a
    # higher-SemVer dev/prerelease build cannot push a shipped release into "Other".
    kept_versions = _retained_versions(
        explicit_versions, active_versions, keep_releases, released=released
    )

    def _display_key(version: str, is_other: bool) -> tuple[str, bool]:
        if not is_other and version in kept_versions:
            return (version, False)
        return (APP_VERSION_OTHER_LABEL, True)

    folded_metric_rows: dict[tuple[str, bool], dict[datetime, int]] = {}
    for (version, is_other), rows in metric_rows_by_series.items():
        bucket_counts = folded_metric_rows.setdefault(_display_key(version, is_other), {})
        for bucket, count in rows:
            bucket_counts[bucket] = bucket_counts.get(bucket, 0) + count
    metric_rows_by_display: dict[tuple[str, bool], list[tuple[datetime, int]]] = {
        key: sorted(counts.items()) for key, counts in folded_metric_rows.items()
    }

    keys = set(metric_rows_by_display)
    ordered_keys = _order_app_version_keys(keys)

    # Prefer the SemVer-max ACTIVE released version; fall back to the SemVer-max
    # released version only when nothing has activated yet (a young project still
    # ramping). Prereleases are excluded from both, so they are never latest.
    latest_version = (
        order_versions(active_versions, reverse=True)[0]
        if active_versions
        else _latest_app_version(keys, released)
    )

    def _is_active(version: str, is_other: bool) -> bool:
        return not is_other and version in active_versions

    versions = [
        AppVersionInfo(
            version=version,
            is_other=is_other,
            is_latest=not is_other and version == latest_version,
            is_active=_is_active(version, is_other),
        )
        for version, is_other in ordered_keys
    ]

    series: list[AppVersionMetricSeries] = []
    for version, is_other in ordered_keys:
        key = (version, is_other)
        data = _build_metric_points(
            interval=interval,
            metric_rows=metric_rows_by_display.get(key, []),
            anomalies=[],
        )
        series.append(
            AppVersionMetricSeries(
                version=version,
                is_other=is_other,
                is_latest=not is_other and version == latest_version,
                is_active=_is_active(version, is_other),
                total_count=sum(point.count for point in data),
                data=data,
            )
        )
    return latest_version, versions, series


def _build_app_version_totals(
    metric_rows_by_series: dict[tuple[str, bool], list[tuple[datetime, int]]],
) -> list[BreakdownTimelinePoint]:
    counts_by_bucket: dict[datetime, int] = {}
    for rows in metric_rows_by_series.values():
        for bucket, count in rows:
            counts_by_bucket[bucket] = counts_by_bucket.get(bucket, 0) + count
    return [
        BreakdownTimelinePoint(bucket=bucket, count=count)
        for bucket, count in sorted(counts_by_bucket.items())
    ]


async def get_app_version_series(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str = SCOPE_PROJECT_TOTAL,
    scope_ref: str | None = None,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> AppVersionSeriesResponse:
    project = await _resolve_project(session, slug)
    config = await _resolve_scan_config(session, project.id, scan_config_id)
    resolved_scope_ref = _validate_app_version_scope_ref(
        scope_type=scope_type,
        scope_ref=scope_ref,
        scan_config_id=config.id,
    )
    if not config.app_version_column:
        return AppVersionSeriesResponse(
            scan_config_id=config.id,
            scope_type=scope_type,
            scope_ref=resolved_scope_ref,
            app_version_column=None,
            interval=config.interval,
            versions=[],
            series=[],
        )

    event_id, event_type_id = await _resolve_app_version_scope(
        session,
        project_id=project.id,
        scope_type=scope_type,
        scope_ref=resolved_scope_ref,
    )
    metric_rows_by_series = await _load_app_version_metric_rows(
        session,
        config=config,
        scope_type=scope_type,
        event_id=event_id,
        event_type_id=event_type_id,
        time_from=time_from,
        time_to=time_to,
    )
    maturity_metric_rows_by_series = (
        metric_rows_by_series
        if scope_type == SCOPE_PROJECT_TOTAL
        else await _load_app_version_metric_rows(
            session,
            config=config,
            scope_type=SCOPE_PROJECT_TOTAL,
            event_id=None,
            event_type_id=None,
            time_from=time_from,
            time_to=time_to,
        )
    )
    latest_version, versions, series = _build_app_version_series(
        interval=config.interval,
        metric_rows_by_series=metric_rows_by_series,
        maturity_metric_rows_by_series=maturity_metric_rows_by_series,
        keep_releases=project.app_version_keep_releases,
        prerelease_pattern=compile_prerelease_pattern(config.app_version_prerelease_pattern),
        share_min=resolve_share_min(config.app_version_active_share_min),
    )
    return AppVersionSeriesResponse(
        scan_config_id=config.id,
        scope_type=scope_type,
        scope_ref=resolved_scope_ref,
        event_id=event_id,
        event_type_id=event_type_id,
        app_version_column=config.app_version_column,
        interval=config.interval,
        latest_version=latest_version,
        sigma_threshold=config.sigma_threshold,
        versions=versions,
        series=series,
    )


async def get_app_version_adoption(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> AppVersionAdoptionResponse:
    project = await _resolve_project(session, slug)
    config = await _resolve_scan_config(session, project.id, scan_config_id)
    scope_ref = str(config.id)
    if not config.app_version_column:
        return AppVersionAdoptionResponse(
            scan_config_id=config.id,
            scope_type=SCOPE_PROJECT_TOTAL,
            scope_ref=scope_ref,
            app_version_column=None,
            interval=config.interval,
            versions=[],
            series=[],
            totals=[],
        )

    metric_rows_by_series = await _load_app_version_metric_rows(
        session,
        config=config,
        scope_type=SCOPE_PROJECT_TOTAL,
        event_id=None,
        event_type_id=None,
        time_from=time_from,
        time_to=time_to,
    )
    latest_version, versions, series = _build_app_version_series(
        interval=config.interval,
        metric_rows_by_series=metric_rows_by_series,
        keep_releases=project.app_version_keep_releases,
        prerelease_pattern=compile_prerelease_pattern(config.app_version_prerelease_pattern),
        share_min=resolve_share_min(config.app_version_active_share_min),
    )
    return AppVersionAdoptionResponse(
        scan_config_id=config.id,
        scope_type=SCOPE_PROJECT_TOTAL,
        scope_ref=scope_ref,
        app_version_column=config.app_version_column,
        interval=config.interval,
        latest_version=latest_version,
        sigma_threshold=config.sigma_threshold,
        versions=versions,
        series=series,
        totals=_build_app_version_totals(metric_rows_by_series),
    )


async def get_release_regressions(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str | None = None,
) -> ReleaseRegressionsResponse:
    """Events that changed in the latest active release, per scope.

    Backed by the ReleaseRegression rows the scan recomputes each run (they
    always describe the current latest release). Empty when the scan has no
    version column.
    """
    project = await _resolve_project(session, slug)
    config = await _resolve_scan_config(session, project.id, scan_config_id)
    if not config.app_version_column:
        return ReleaseRegressionsResponse(
            scan_config_id=config.id,
            app_version_column=None,
            latest_version=None,
            items=[],
        )

    stmt = select(ReleaseRegression).where(ReleaseRegression.scan_config_id == config.id)
    if scope_type is not None:
        stmt = stmt.where(ReleaseRegression.scope_type == scope_type)
    regressions = list((await session.execute(stmt)).scalars())
    if not regressions:
        return ReleaseRegressionsResponse(
            scan_config_id=config.id,
            app_version_column=config.app_version_column,
            latest_version=None,
            items=[],
        )

    event_ids = {r.event_id for r in regressions if r.event_id is not None}
    type_ids = {r.event_type_id for r in regressions if r.event_type_id is not None}
    event_names: dict[uuid.UUID, str] = {}
    if event_ids:
        for event_id, name in (
            await session.execute(select(Event.id, Event.name).where(Event.id.in_(event_ids)))
        ).all():
            event_names[event_id] = name
    type_names: dict[uuid.UUID, str] = {}
    if type_ids:
        for type_id, display_name, name in (
            await session.execute(
                select(EventType.id, EventType.display_name, EventType.name).where(
                    EventType.id.in_(type_ids)
                )
            )
        ).all():
            type_names[type_id] = display_name or name

    def _scope_name(regression: ReleaseRegression) -> str:
        if regression.event_id is not None:
            return event_names.get(regression.event_id, regression.scope_ref)
        if regression.event_type_id is not None:
            return type_names.get(regression.event_type_id, regression.scope_ref)
        return regression.scope_ref

    latest_version = order_versions({r.version for r in regressions})[-1]
    # Missing events first, then by severity (lowest ratio = worst).
    ordered = sorted(regressions, key=lambda r: (0 if r.kind == "missing" else 1, r.ratio))
    items = [
        ReleaseRegressionItem(
            scope_type=regression.scope_type,
            scope_ref=regression.scope_ref,
            scope_name=_scope_name(regression),
            event_id=regression.event_id,
            event_type_id=regression.event_type_id,
            kind=regression.kind,
            version=regression.version,
            previous_version=regression.previous_version,
            observed_count=regression.observed_count,
            expected_count=regression.expected_count,
            ratio=regression.ratio,
            share_prev=regression.share_prev,
            share_new=regression.share_new,
            release_share=regression.release_share,
            window_from=regression.window_from,
            window_to=regression.window_to,
        )
        for regression in ordered
    ]
    return ReleaseRegressionsResponse(
        scan_config_id=config.id,
        app_version_column=config.app_version_column,
        latest_version=latest_version,
        items=items,
    )


async def get_platform_presence(
    session: AsyncSession,
    slug: str,
    scan_config_id: uuid.UUID,
) -> PlatformPresenceResponse:
    """Per-event platform presence matrix for a scan's designated platform column.

    Presence is derived from the generic breakdown rows the metrics worker stores
    under ``platform_column`` (event-scope, real values only, count > 0): an event
    is "present" on a platform if it has any such stored row. Empty when the scan
    has no ``platform_column`` configured. Read-only; cheap index-backed query.
    """
    project = await _resolve_project(session, slug)
    config = await _resolve_scan_config(session, project.id, scan_config_id)
    if not config.platform_column:
        return PlatformPresenceResponse(
            scan_config_id=config.id, platform_column=None, platforms=[], items=[]
        )

    rows = await session.execute(
        select(
            EventMetricBreakdown.event_id,
            EventMetricBreakdown.breakdown_value,
            Event.name,
        )
        .join(Event, Event.id == EventMetricBreakdown.event_id)
        .where(
            EventMetricBreakdown.scan_config_id == config.id,
            EventMetricBreakdown.breakdown_column == config.platform_column,
            EventMetricBreakdown.event_id.is_not(None),
            EventMetricBreakdown.is_other.is_(False),
            EventMetricBreakdown.count > 0,
        )
    )
    platforms: set[str] = set()
    by_event: dict[uuid.UUID, tuple[str, set[str]]] = {}
    for event_id, platform_value, event_name in rows.all():
        platforms.add(platform_value)
        _name, present = by_event.setdefault(event_id, (event_name, set()))
        present.add(platform_value)

    items = [
        PlatformPresenceRow(
            event_id=event_id,
            event_name=name,
            present_platforms=sorted(present),
        )
        for event_id, (name, present) in sorted(by_event.items(), key=lambda kv: kv[1][0])
    ]
    return PlatformPresenceResponse(
        scan_config_id=config.id,
        platform_column=config.platform_column,
        platforms=sorted(platforms),
        items=items,
    )


async def get_events_metrics(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID | None = None,
    search: str | None = None,
    tag: str | None = None,
    status: list[str] | None = None,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> EventMetricsResponse:
    project = await _resolve_project(session, slug)
    # Scope the "All Events Dynamics" series to a single scan — the same default
    # scan the project-total volume sparkline resolves — rather than summing
    # EventMetric rows across every scan_config. An unscoped cross-scan sum
    # double-counts events that a legacy/backfill scan (e.g. an "Old events" scan)
    # also collected, which inflated one bucket into the outlier that dominated the
    # chart's y-axis. Mirrors get_project_total_metrics / _get_metric_rows scoping.
    scan_config_id = await _get_default_scan_config_id(session, project.id)
    if scan_config_id is None:
        return EventMetricsResponse(scope="events_total", data=[])

    query = (
        select(EventMetric.bucket, func.sum(EventMetric.count))
        .join(Event, EventMetric.event_id == Event.id)
        .where(
            Event.project_id == project.id,
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.event_id.is_not(None),
        )
    )

    if event_type_id:
        query = query.where(Event.event_type_id == event_type_id)
    if search:
        query = query.where(Event.name.ilike(f"%{search}%"))
    if status:
        query = query.where(Event.status.in_(status))
    if tag:
        tagged_event_ids = select(EventTag.event_id).where(EventTag.name == tag).correlate(None)
        query = query.where(Event.id.in_(tagged_event_ids))
    if time_from:
        query = query.where(EventMetric.bucket >= time_from)
    if time_to:
        query = query.where(EventMetric.bucket < time_to)

    result = await session.execute(query.group_by(EventMetric.bucket).order_by(EventMetric.bucket))
    rows = [(bucket, int(count)) for bucket, count in result.all()]

    interval = await _get_scan_config_interval(session, scan_config_id) if rows else None

    return EventMetricsResponse(
        scope="events_total",
        interval=interval,
        data=[EventMetricPoint(bucket=bucket, count=count) for bucket, count in rows],
    )


async def get_overview_kpi_series(
    session: AsyncSession,
    slug: str,
    *,
    days: int = 14,
) -> OverviewKpiSeriesResponse:
    """Daily new-event counts (from Event.created_at) for the Overview
    'active events' KPI sparkline — the one KPI with genuine history."""
    project = await _resolve_project(session, slug)
    start_day = (datetime.now(UTC) - timedelta(days=days - 1)).date()
    time_from = datetime(start_day.year, start_day.month, start_day.day, tzinfo=UTC)
    created_ats = (
        (
            await session.execute(
                select(Event.created_at).where(
                    Event.project_id == project.id,
                    Event.created_at >= time_from,
                )
            )
        )
        .scalars()
        .all()
    )
    counts: dict[date, int] = {}
    for created in created_ats:
        day = created.date()
        counts[day] = counts.get(day, 0) + 1
    series = [counts.get(start_day + timedelta(days=i), 0) for i in range(days)]
    return OverviewKpiSeriesResponse(days=days, active_events=series)


async def get_top_events_by_volume(
    session: AsyncSession,
    slug: str,
    *,
    window_hours: int = 48,
    limit: int = 6,
) -> list[TopEventResponse]:
    """Rank a project's events by total volume over a recent window.

    Sums EventMetric.count per event (scoped to the project via ScanConfig) and
    returns the top ``limit`` by volume — the data behind the Overview "Top
    events by volume" widget, computed server-side so the client need not fetch
    window metrics for every event just to show a handful.
    """
    project = await _resolve_project(session, slug)
    time_from = datetime.now(UTC) - timedelta(hours=window_hours)
    total = func.coalesce(func.sum(EventMetric.count), 0)
    rows = (
        await session.execute(
            select(Event.id, Event.name, Event.event_type_id, total.label("total"))
            .join(EventMetric, EventMetric.event_id == Event.id)
            .join(ScanConfig, ScanConfig.id == EventMetric.scan_config_id)
            .where(
                ScanConfig.project_id == project.id,
                EventMetric.bucket >= time_from,
            )
            .group_by(Event.id, Event.name, Event.event_type_id)
            .order_by(total.desc())
            .limit(limit)
        )
    ).all()
    return [
        TopEventResponse(
            event_id=row.id,
            name=row.name,
            event_type_id=row.event_type_id,
            total_count=int(row.total or 0),
        )
        for row in rows
    ]


async def get_data_source_stats(
    session: AsyncSession,
    data_source_id: uuid.UUID,
    *,
    window_hours: int = 48,
) -> DataSourceStatsResponse:
    """Aggregate runtime activity for a data source from EventMetric rollups.

    Volume + events-tracked + a bucketed throughput series over the recent
    window, joined to the data source via ScanConfig. Backs the redesign's
    data-source health/throughput cards.
    """
    time_from = datetime.now(UTC) - timedelta(hours=window_hours)
    totals = (
        await session.execute(
            select(
                func.coalesce(func.sum(EventMetric.count), 0),
                func.count(func.distinct(EventMetric.event_id)),
            )
            .join(ScanConfig, ScanConfig.id == EventMetric.scan_config_id)
            .where(ScanConfig.data_source_id == data_source_id, EventMetric.bucket >= time_from)
        )
    ).one()
    series_rows = (
        await session.execute(
            select(EventMetric.bucket, func.coalesce(func.sum(EventMetric.count), 0))
            .join(ScanConfig, ScanConfig.id == EventMetric.scan_config_id)
            .where(ScanConfig.data_source_id == data_source_id, EventMetric.bucket >= time_from)
            .group_by(EventMetric.bucket)
            .order_by(EventMetric.bucket)
        )
    ).all()
    return DataSourceStatsResponse(
        events_tracked=int(totals[1] or 0),
        volume_window=int(totals[0] or 0),
        window_hours=window_hours,
        throughput=[
            DataSourceThroughputPoint(bucket=bucket, count=int(count or 0))
            for bucket, count in series_rows
        ],
    )


async def get_events_window_metrics(
    session: AsyncSession,
    slug: str,
    *,
    event_ids: list[uuid.UUID],
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> list[EventWindowMetricsResponse]:
    if not event_ids:
        return []

    project = await _resolve_project(session, slug)
    valid_event_ids = list(
        (
            await session.execute(
                select(Event.id).where(
                    Event.project_id == project.id,
                    Event.id.in_(event_ids),
                )
            )
        ).scalars()
    )
    if not valid_event_ids:
        return []

    latest_rows = (
        await session.execute(
            select(EventMetric.event_id, EventMetric.scan_config_id, EventMetric.bucket)
            .join(ScanConfig, ScanConfig.id == EventMetric.scan_config_id)
            .where(
                ScanConfig.project_id == project.id,
                EventMetric.event_id.in_(valid_event_ids),
            )
            .order_by(EventMetric.event_id, EventMetric.bucket.desc())
        )
    ).all()

    latest_scan_by_event: dict[uuid.UUID, uuid.UUID] = {}
    for event_id, scan_config_id, _bucket in latest_rows:
        if event_id is not None and event_id not in latest_scan_by_event:
            latest_scan_by_event[event_id] = scan_config_id

    interval_by_scan: dict[uuid.UUID, str | None] = {}
    if latest_scan_by_event:
        interval_rows = (
            await session.execute(
                select(ScanConfig.id, ScanConfig.interval).where(
                    ScanConfig.id.in_(set(latest_scan_by_event.values()))
                )
            )
        ).all()
        interval_by_scan = {scan_config_id: interval for scan_config_id, interval in interval_rows}

    metric_rows_by_event: dict[uuid.UUID, list[tuple[datetime, int]]] = {
        event_id: [] for event_id in valid_event_ids
    }
    if latest_scan_by_event:
        metric_query = (
            select(
                EventMetric.event_id,
                EventMetric.scan_config_id,
                EventMetric.bucket,
                EventMetric.count,
            )
            .where(
                EventMetric.event_id.in_(valid_event_ids),
                EventMetric.scan_config_id.in_(set(latest_scan_by_event.values())),
            )
            .order_by(EventMetric.event_id, EventMetric.bucket)
        )
        if time_from is not None:
            metric_query = metric_query.where(EventMetric.bucket >= time_from)
        if time_to is not None:
            metric_query = metric_query.where(EventMetric.bucket < time_to)

        for event_id, scan_config_id, bucket, count in (await session.execute(metric_query)).all():
            if event_id is None:
                continue
            if latest_scan_by_event.get(event_id) != scan_config_id:
                continue
            metric_rows_by_event.setdefault(event_id, []).append((bucket, int(count)))

    anomaly_rows_by_event: dict[uuid.UUID, list[MetricAnomaly]] = {
        event_id: [] for event_id in valid_event_ids
    }
    if latest_scan_by_event:
        anomaly_query = (
            select(MetricAnomaly)
            .where(
                MetricAnomaly.scope_type == SCOPE_EVENT,
                MetricAnomaly.event_id.in_(valid_event_ids),
                MetricAnomaly.scan_config_id.in_(set(latest_scan_by_event.values())),
            )
            .order_by(MetricAnomaly.event_id, MetricAnomaly.bucket)
        )
        if time_from is not None:
            anomaly_query = anomaly_query.where(MetricAnomaly.bucket >= time_from)
        if time_to is not None:
            anomaly_query = anomaly_query.where(MetricAnomaly.bucket < time_to)

        for anomaly in (await session.execute(anomaly_query)).scalars():
            if anomaly.event_id is None:
                continue
            if latest_scan_by_event.get(anomaly.event_id) != anomaly.scan_config_id:
                continue
            anomaly_rows_by_event.setdefault(anomaly.event_id, []).append(anomaly)

    valid_event_ids_set = set(valid_event_ids)
    responses: list[EventWindowMetricsResponse] = []
    for event_id in event_ids:
        if event_id not in valid_event_ids_set:
            continue

        scan_config_id = latest_scan_by_event.get(event_id)
        interval = interval_by_scan.get(scan_config_id) if scan_config_id is not None else None
        metric_rows = metric_rows_by_event.get(event_id, [])
        metrics_response = _build_metrics_response(
            scope=SCOPE_EVENT,
            scan_config_id=scan_config_id,
            scope_ref=str(event_id),
            interval=interval,
            metric_rows=metric_rows,
            anomalies=anomaly_rows_by_event.get(event_id, []),
            event_id=event_id,
        )
        responses.append(
            EventWindowMetricsResponse(
                event_id=event_id,
                scan_config_id=scan_config_id,
                interval=interval,
                total_count=sum(count for _bucket, count in metric_rows),
                data=metrics_response.data,
            )
        )

    return responses


async def get_event_type_metrics(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> EventMetricsResponse:
    project = await _resolve_project(session, slug)
    event_type = await _resolve_event_type(session, project.id, event_type_id)
    scan_config_id = await _resolve_scope_scan_config_id(
        session,
        project.id,
        event_type_id=event_type.id,
    )
    interval = await _get_scan_config_interval(session, scan_config_id)
    if scan_config_id is None:
        return EventMetricsResponse(
            scope=SCOPE_EVENT_TYPE,
            event_type_id=event_type.id,
            interval=interval,
            data=[],
        )

    metric_rows = await _get_metric_rows(
        session,
        scope=SCOPE_EVENT_TYPE,
        scan_config_id=scan_config_id,
        scope_ref=str(event_type.id),
        time_from=time_from,
        time_to=time_to,
    )
    anomalies = await _get_anomaly_rows(
        session,
        scan_config_id=scan_config_id,
        scope=SCOPE_EVENT_TYPE,
        scope_ref=str(event_type.id),
        time_from=time_from,
        time_to=time_to,
    )
    sigma_threshold = await _get_scan_config_sigma_threshold(session, scan_config_id)
    return _build_metrics_response(
        scope=SCOPE_EVENT_TYPE,
        scan_config_id=scan_config_id,
        scope_ref=str(event_type.id),
        interval=interval,
        metric_rows=metric_rows,
        anomalies=anomalies,
        event_type_id=event_type.id,
        sigma_threshold=sigma_threshold,
    )


async def get_project_total_metrics(
    session: AsyncSession,
    slug: str,
    scan_config_id: uuid.UUID | None = None,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> EventMetricsResponse:
    project = await _resolve_project(session, slug)
    resolved_scan_config_id = scan_config_id or await _get_default_scan_config_id(
        session, project.id
    )
    if resolved_scan_config_id is None:
        return EventMetricsResponse(scope=SCOPE_PROJECT_TOTAL, data=[])

    config = await session.get(ScanConfig, resolved_scan_config_id)
    if config is None or config.project_id != project.id:
        raise HTTPException(404, "Scan config not found")

    metric_rows = await _get_metric_rows(
        session,
        scope=SCOPE_PROJECT_TOTAL,
        scan_config_id=resolved_scan_config_id,
        scope_ref=str(resolved_scan_config_id),
        time_from=time_from,
        time_to=time_to,
    )
    anomalies = await _get_anomaly_rows(
        session,
        scan_config_id=resolved_scan_config_id,
        scope=SCOPE_PROJECT_TOTAL,
        scope_ref=str(resolved_scan_config_id),
        time_from=time_from,
        time_to=time_to,
    )
    return _build_metrics_response(
        scope=SCOPE_PROJECT_TOTAL,
        scan_config_id=resolved_scan_config_id,
        scope_ref=str(resolved_scan_config_id),
        interval=config.interval,
        metric_rows=metric_rows,
        anomalies=anomalies,
        sigma_threshold=config.sigma_threshold,
    )
