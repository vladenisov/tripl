"""Read service for catalog-metric (MetricDefinition) series.

Loads ``MetricValue`` rows for a definition, densifies them onto the interval
grid, joins anomaly flags, and attaches a one-step forecast — returning a
payload shaped like the event-metric series but with float values. Breakdown
and app-version variants mirror the event equivalents.

Reuse, not duplication: the densify-to-grid primitive (``expand_series``), the
forecast (``forecast_next_buckets``), the anomaly→signal mapping
(``_signal_from_anomaly``) and the signal-state classifier
(``classify_signal_state``) are all imported, not reimplemented. Only the
float/no-event-scope shaping is specialised here.

ANOMALY-SCOPE (ticket tripl-dxhp.6): catalog-metric anomalies are stored in
``MetricAnomaly`` under ``scope_type='metric'`` /
``scope_ref=str(metric_definition_id)`` with a NULL ``scan_config_id``. The read
filters on BOTH ``scope_type == MetricScopeType.metric`` and the scope_ref so it
can never pick up an unrelated row whose scope_ref happens to equal a metric
definition UUID.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.analyzers.anomaly_detector import (
    SCOPE_METRIC,
    SeriesPoint,
    expand_series,
    forecast_next_buckets,
)
from tripl.core.intervals import get_interval
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.metric_value_breakdown import MetricValueBreakdown
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.schemas.event_metric import AppVersionInfo, ForecastPoint, MetricSignalResponse
from tripl.schemas.metric_series import (
    MetricBreakdownSeries,
    MetricBreakdownsResponse,
    MetricSeriesPoint,
    MetricSeriesResponse,
    MetricVersionSeries,
    MetricVersionSeriesResponse,
)
from tripl.semver import (
    APP_VERSION_OTHER_LABEL,
    DEFAULT_APP_VERSION_KEEP_RELEASES,
    order_versions,
)
from tripl.services.metrics_service import _resolve_project, _signal_from_anomaly
from tripl.services.monitoring_utils import classify_signal_state
from tripl.worker.analyzers.metric_value_kind import is_count_shaped


async def _resolve_metric(
    session: AsyncSession,
    project: Project,
    metric_id: uuid.UUID,
) -> MetricDefinition:
    metric = await session.get(MetricDefinition, metric_id)
    if metric is None or metric.project_id != project.id:
        raise HTTPException(404, "Metric definition not found")
    return metric


async def _resolve_metric_interval(
    session: AsyncSession,
    metric: MetricDefinition,
) -> tuple[str | None, uuid.UUID | None]:
    """Interval + source scan_config for the metric's grid.

    ``sql`` / ``fact`` metrics collect on their own ``interval``.
    ``event_composition`` metrics leave ``interval`` NULL and align onto a
    source scan grid, so the interval is taken from the ``scan_config_id``
    stamped on their stored values.

    A metric whose values were collected under more than one ``scan_config_id``
    (e.g. after a source config was recreated) must resolve deterministically to
    the grid currently in use, so the most-recent bucket's ``scan_config_id`` is
    selected via ``ORDER BY bucket DESC``. Without it the engine could return any
    matching row and silently apply the wrong bucket grid to the whole series.
    """
    scan_config_id = await session.scalar(
        select(MetricValue.scan_config_id)
        .where(
            MetricValue.metric_definition_id == metric.id,
            MetricValue.scan_config_id.is_not(None),
        )
        .order_by(MetricValue.bucket.desc())
        .limit(1)
    )
    if metric.interval is not None:
        return metric.interval, scan_config_id
    if scan_config_id is not None:
        interval = await session.scalar(
            select(ScanConfig.interval).where(ScanConfig.id == scan_config_id)
        )
        return interval, scan_config_id
    return None, scan_config_id


async def _load_metric_values(
    session: AsyncSession,
    metric_id: uuid.UUID,
    *,
    time_from: datetime | None,
    time_to: datetime | None,
) -> list[tuple[datetime, float]]:
    query = (
        select(MetricValue.bucket, MetricValue.value)
        .where(MetricValue.metric_definition_id == metric_id)
        .order_by(MetricValue.bucket)
    )
    if time_from is not None:
        query = query.where(MetricValue.bucket >= time_from)
    if time_to is not None:
        query = query.where(MetricValue.bucket < time_to)
    result = await session.execute(query)
    return [(bucket, float(value)) for bucket, value in result.all()]


async def _load_metric_anomalies(
    session: AsyncSession,
    metric_id: uuid.UUID,
    *,
    time_from: datetime | None,
    time_to: datetime | None,
) -> list[MetricAnomaly]:
    """Anomalies for a metric, matched on (scope_type='metric', scope_ref)."""
    query = (
        select(MetricAnomaly)
        .where(
            MetricAnomaly.scope_type == SCOPE_METRIC,
            MetricAnomaly.scope_ref == str(metric_id),
        )
        .order_by(MetricAnomaly.bucket)
    )
    if time_from is not None:
        query = query.where(MetricAnomaly.bucket >= time_from)
    if time_to is not None:
        query = query.where(MetricAnomaly.bucket < time_to)
    result = await session.execute(query)
    return list(result.scalars().all())


def _densify_value_rows(
    *,
    interval: str | None,
    value_rows: list[tuple[datetime, float]],
    anomalies: list[MetricAnomaly],
    count_shaped: bool = True,
) -> list[tuple[datetime, float]]:
    """Place values on the interval grid, preserving float precision.

    For COUNT-shaped metrics ``expand_series`` produces the densified bucket grid
    (off a rounded copy) and gap buckets are filled as ``0.0`` — a missing count
    genuinely means zero. For FRACTIONAL metrics (ratios/averages/sql) a missing
    bucket means "no data", not zero, so gaps are NOT filled: only present
    buckets are returned and the chart renders the gaps as null breaks.
    """
    values_by_bucket: dict[datetime, float] = dict(value_rows)
    for anomaly in anomalies:
        values_by_bucket.setdefault(anomaly.bucket, float(anomaly.actual_count))

    if interval and values_by_bucket and count_shaped:
        delta = get_interval(interval).delta
        grid_points = [
            SeriesPoint(bucket=bucket, count=round(value))
            for bucket, value in values_by_bucket.items()
        ]
        expanded = expand_series(
            grid_points,
            interval=delta,
            end_exclusive=max(values_by_bucket) + delta,
        )
        return [(point.bucket, values_by_bucket.get(point.bucket, 0.0)) for point in expanded]
    return sorted(values_by_bucket.items())


def _build_metric_series_points(
    *,
    interval: str | None,
    value_rows: list[tuple[datetime, float]],
    anomalies: list[MetricAnomaly],
    count_shaped: bool = True,
) -> list[MetricSeriesPoint]:
    anomalies_by_bucket = {anomaly.bucket: anomaly for anomaly in anomalies}
    grid = _densify_value_rows(
        interval=interval,
        value_rows=value_rows,
        anomalies=anomalies,
        count_shaped=count_shaped,
    )
    points: list[MetricSeriesPoint] = []
    for bucket, value in grid:
        anomaly = anomalies_by_bucket.get(bucket)
        points.append(
            MetricSeriesPoint(
                bucket=bucket,
                value=value,
                expected_count=anomaly.expected_count if anomaly else None,
                stddev=anomaly.stddev if anomaly else None,
                is_anomaly=anomaly is not None,
                anomaly_direction=anomaly.direction if anomaly else None,
                z_score=anomaly.z_score if anomaly else None,
            )
        )
    return points


def _forecast_from_series(
    *,
    data: list[MetricSeriesPoint],
    interval: str | None,
) -> list[ForecastPoint]:
    if not data or not interval:
        return []
    delta = get_interval(interval).delta
    series_points = [SeriesPoint(bucket=point.bucket, count=round(point.value)) for point in data]
    return [
        ForecastPoint(
            bucket=point.bucket,
            expected_count=point.expected_count,
            stddev=point.stddev,
        )
        for point in forecast_next_buckets(series_points, interval=delta, horizon=1)
    ]


def _latest_signal(
    *,
    data: list[MetricSeriesPoint],
    anomalies: list[MetricAnomaly],
) -> MetricSignalResponse | None:
    if not anomalies:
        return None
    latest_metric_bucket = data[-1].bucket if data else None
    latest_anomaly = anomalies[-1]
    state = classify_signal_state(
        anomaly_bucket=latest_anomaly.bucket,
        latest_metric_bucket=latest_metric_bucket,
    )
    if state is None:
        return None
    return _signal_from_anomaly(latest_anomaly, state=state)


async def get_metric_series(
    session: AsyncSession,
    slug: str,
    metric_id: uuid.UUID,
    *,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> MetricSeriesResponse:
    project = await _resolve_project(session, slug)
    metric = await _resolve_metric(session, project, metric_id)
    interval, scan_config_id = await _resolve_metric_interval(session, metric)

    value_rows = await _load_metric_values(session, metric.id, time_from=time_from, time_to=time_to)
    anomalies = await _load_metric_anomalies(
        session, metric.id, time_from=time_from, time_to=time_to
    )
    data = _build_metric_series_points(
        interval=interval,
        value_rows=value_rows,
        anomalies=anomalies,
        count_shaped=is_count_shaped(metric),
    )
    return MetricSeriesResponse(
        metric_id=metric.id,
        scan_config_id=scan_config_id,
        interval=interval,
        latest_signal=_latest_signal(data=data, anomalies=anomalies),
        data=data,
        forecast=_forecast_from_series(data=data, interval=interval),
    )


async def _load_breakdown_value_rows(
    session: AsyncSession,
    metric_id: uuid.UUID,
    *,
    breakdown_column: str,
    time_from: datetime | None,
    time_to: datetime | None,
) -> dict[tuple[str, bool], list[tuple[datetime, float]]]:
    query = (
        select(
            MetricValueBreakdown.breakdown_value,
            MetricValueBreakdown.is_other,
            MetricValueBreakdown.bucket,
            func.sum(MetricValueBreakdown.value),
        )
        .where(
            MetricValueBreakdown.metric_definition_id == metric_id,
            MetricValueBreakdown.breakdown_column == breakdown_column,
        )
        .group_by(
            MetricValueBreakdown.breakdown_value,
            MetricValueBreakdown.is_other,
            MetricValueBreakdown.bucket,
        )
        .order_by(MetricValueBreakdown.breakdown_value, MetricValueBreakdown.bucket)
    )
    if time_from is not None:
        query = query.where(MetricValueBreakdown.bucket >= time_from)
    if time_to is not None:
        query = query.where(MetricValueBreakdown.bucket < time_to)

    rows_by_series: dict[tuple[str, bool], list[tuple[datetime, float]]] = {}
    for value, is_other, bucket, total in (await session.execute(query)).all():
        rows_by_series.setdefault((value, bool(is_other)), []).append((bucket, float(total)))
    return rows_by_series


async def get_metric_breakdowns(
    session: AsyncSession,
    slug: str,
    metric_id: uuid.UUID,
    *,
    column: str | None = None,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> MetricBreakdownsResponse:
    project = await _resolve_project(session, slug)
    metric = await _resolve_metric(session, project, metric_id)
    interval, scan_config_id = await _resolve_metric_interval(session, metric)
    columns = list(dict.fromkeys(metric.breakdown_columns or []))

    if column is not None and column not in columns:
        raise HTTPException(400, "Breakdown column is not configured for this metric")
    if not columns:
        return MetricBreakdownsResponse(
            metric_id=metric.id,
            scan_config_id=scan_config_id,
            interval=interval,
            columns=[],
            series=[],
        )

    selected_column = column
    if selected_column is None:
        data_columns = set(
            (
                await session.execute(
                    select(MetricValueBreakdown.breakdown_column)
                    .where(MetricValueBreakdown.metric_definition_id == metric.id)
                    .distinct()
                )
            ).scalars()
        )
        selected_column = next((item for item in columns if item in data_columns), columns[0])

    rows_by_series = await _load_breakdown_value_rows(
        session,
        metric.id,
        breakdown_column=selected_column,
        time_from=time_from,
        time_to=time_to,
    )
    series: list[MetricBreakdownSeries] = []
    for (value, is_other), value_rows in rows_by_series.items():
        points = _build_metric_series_points(interval=interval, value_rows=value_rows, anomalies=[])
        series.append(
            MetricBreakdownSeries(
                breakdown_value=value,
                is_other=is_other,
                total_value=sum(point.value for point in points),
                data=points,
            )
        )
    series.sort(key=lambda item: (item.is_other, -item.total_value, item.breakdown_value))
    return MetricBreakdownsResponse(
        metric_id=metric.id,
        scan_config_id=scan_config_id,
        interval=interval,
        columns=columns,
        selected_column=selected_column,
        series=series,
    )


def _order_version_keys(keys: set[tuple[str, bool]]) -> tuple[list[tuple[str, bool]], str | None]:
    explicit = {version for version, is_other in keys if not is_other}
    ordered_versions = order_versions(explicit, reverse=True)
    ordered = [(version, False) for version in ordered_versions]
    other = sorted((version, is_other) for version, is_other in keys if is_other)
    latest = ordered_versions[0] if ordered_versions else None
    return ordered + other, latest


def _build_metric_version_series(
    *,
    interval: str | None,
    value_rows_by_series: dict[tuple[str, bool], list[tuple[datetime, float]]],
    keep_releases: int,
) -> tuple[str | None, list[AppVersionInfo], list[MetricVersionSeries]]:
    """Read-time retention: keep the latest ``keep_releases`` versions by SemVer
    as explicit series and fold the rest (plus any stored ``is_other`` rows) into
    a single "Other" series. Mirrors the event app-version shaping for floats."""
    explicit = {version for version, is_other in value_rows_by_series if not is_other}
    kept = set(order_versions(explicit, reverse=True)[:keep_releases])

    def _display_key(version: str, is_other: bool) -> tuple[str, bool]:
        if not is_other and version in kept:
            return (version, False)
        return (APP_VERSION_OTHER_LABEL, True)

    folded: dict[tuple[str, bool], dict[datetime, float]] = {}
    for (version, is_other), rows in value_rows_by_series.items():
        bucket_values = folded.setdefault(_display_key(version, is_other), {})
        for bucket, value in rows:
            bucket_values[bucket] = bucket_values.get(bucket, 0.0) + value
    rows_by_display = {key: sorted(values.items()) for key, values in folded.items()}

    ordered_keys, latest_version = _order_version_keys(set(rows_by_display))
    versions = [
        AppVersionInfo(
            version=version,
            is_other=is_other,
            is_latest=not is_other and version == latest_version,
        )
        for version, is_other in ordered_keys
    ]
    series: list[MetricVersionSeries] = []
    for version, is_other in ordered_keys:
        points = _build_metric_series_points(
            interval=interval,
            value_rows=rows_by_display.get((version, is_other), []),
            anomalies=[],
        )
        series.append(
            MetricVersionSeries(
                version=version,
                is_other=is_other,
                is_latest=not is_other and version == latest_version,
                total_value=sum(point.value for point in points),
                data=points,
            )
        )
    return latest_version, versions, series


async def get_metric_version_series(
    session: AsyncSession,
    slug: str,
    metric_id: uuid.UUID,
    *,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> MetricVersionSeriesResponse:
    project = await _resolve_project(session, slug)
    metric = await _resolve_metric(session, project, metric_id)
    interval, scan_config_id = await _resolve_metric_interval(session, metric)
    if not metric.app_version_column:
        return MetricVersionSeriesResponse(
            metric_id=metric.id,
            scan_config_id=scan_config_id,
            app_version_column=None,
            interval=interval,
            versions=[],
            series=[],
        )

    value_rows_by_series = await _load_breakdown_value_rows(
        session,
        metric.id,
        breakdown_column=metric.app_version_column,
        time_from=time_from,
        time_to=time_to,
    )
    latest_version, versions, series = _build_metric_version_series(
        interval=interval,
        value_rows_by_series=value_rows_by_series,
        keep_releases=DEFAULT_APP_VERSION_KEEP_RELEASES,
    )
    return MetricVersionSeriesResponse(
        metric_id=metric.id,
        scan_config_id=scan_config_id,
        app_version_column=metric.app_version_column,
        interval=interval,
        latest_version=latest_version,
        versions=versions,
        series=series,
    )
