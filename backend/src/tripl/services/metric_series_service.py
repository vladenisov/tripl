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

import re
import uuid
from datetime import datetime
from typing import cast

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
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.fact_table import FactTable
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
    order_versions,
)
from tripl.services.metrics_service import (
    _resolve_project,
    _retained_versions,
    _signal_from_anomaly,
)
from tripl.services.monitoring_utils import classify_signal_state
from tripl.services.version_activation import (
    DEFAULT_ACTIVE_SHARE_MIN,
    active_release_versions,
    compile_prerelease_pattern,
    released_versions,
    resolve_share_min,
)
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


def _order_version_keys(
    keys: set[tuple[str, bool]], released: set[str] | None = None
) -> tuple[list[tuple[str, bool]], str | None]:
    explicit = {version for version, is_other in keys if not is_other}
    ordered_versions = order_versions(explicit, reverse=True)
    ordered = [(version, False) for version in ordered_versions]
    other = sorted((version, is_other) for version, is_other in keys if is_other)
    # The SemVer-max fallback for "latest" must skip prerelease/dev builds; when
    # ``released`` is omitted every version is eligible (prior behavior).
    latest_candidates = (
        ordered_versions if released is None else [v for v in ordered_versions if v in released]
    )
    latest = latest_candidates[0] if latest_candidates else None
    return ordered + other, latest


def _version_bucket_totals(
    value_rows_by_series: dict[tuple[str, bool], list[tuple[datetime, float]]],
) -> tuple[dict[str, dict[datetime, float]], dict[datetime, float]]:
    """Per-version and total per-bucket VALUE totals from the raw (pre-fold) rows.

    Only explicit (non-``is_other``) versions get a per-version series, but every
    row — including stored "Other" rows — feeds the traffic denominator so the
    activation shares are not inflated.
    """
    per_version: dict[str, dict[datetime, float]] = {}
    all_by_bucket: dict[datetime, float] = {}
    for (version, is_other), rows in value_rows_by_series.items():
        for bucket, value in rows:
            all_by_bucket[bucket] = all_by_bucket.get(bucket, 0.0) + value
            if not is_other:
                by_bucket = per_version.setdefault(version, {})
                by_bucket[bucket] = by_bucket.get(bucket, 0.0) + value
    return per_version, all_by_bucket


def _build_metric_version_series(
    *,
    interval: str | None,
    value_rows_by_series: dict[tuple[str, bool], list[tuple[datetime, float]]],
    maturity_rows_by_series: dict[tuple[str, bool], list[tuple[datetime, float]]] | None = None,
    keep_releases: int,
    count_shaped: bool = True,
    prerelease_pattern: re.Pattern[str] | None = None,
    share_min: float = DEFAULT_ACTIVE_SHARE_MIN,
) -> tuple[str | None, list[AppVersionInfo], list[MetricVersionSeries]]:
    """Read-time retention with project-total release maturity for all metric shapes.

    Chart values remain metric-local, but rollout maturity comes from project
    version totals. This makes a release's latest/pre-release state consistent
    across counts, ratios, and every event view. If project totals are not yet
    available, the metric's own rows remain a backwards-compatible fallback.
    """
    explicit = {version for version, is_other in value_rows_by_series if not is_other}
    maturity_rows = maturity_rows_by_series or value_rows_by_series
    per_version_totals, all_by_bucket = _version_bucket_totals(maturity_rows)

    # Prerelease/dev builds are ineligible to be latest/active and are subordinate
    # to released versions for retention. Maturity is computed only over released
    # project-total rows, so a prerelease is never marked active.
    released = released_versions(explicit, prerelease_pattern=prerelease_pattern)
    maturity_released = released_versions(
        {version for version, is_other in maturity_rows if not is_other},
        prerelease_pattern=prerelease_pattern,
    )
    released_totals = {
        version: by_bucket
        for version, by_bucket in per_version_totals.items()
        if version in maturity_released
    }
    active_versions = (
        released
        if not maturity_rows_by_series and not count_shaped
        else active_release_versions(released_totals, all_by_bucket, share_min=share_min) & explicit
    )
    kept = _retained_versions(explicit, active_versions, keep_releases, released=released)

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

    ordered_keys, semver_latest = _order_version_keys(set(rows_by_display), released=released)
    # Prefer the SemVer-max mature release from the shared project total; fall
    # back to the visible SemVer-max released version before any total is mature.
    # Prereleases are excluded from both, so never latest.
    latest_version = (
        order_versions(active_versions, reverse=True)[0] if active_versions else semver_latest
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
    series: list[MetricVersionSeries] = []
    for version, is_other in ordered_keys:
        points = _build_metric_series_points(
            interval=interval,
            value_rows=rows_by_display.get((version, is_other), []),
            anomalies=[],
            count_shaped=count_shaped,
        )
        series.append(
            MetricVersionSeries(
                version=version,
                is_other=is_other,
                is_latest=not is_other and version == latest_version,
                is_active=_is_active(version, is_other),
                total_value=sum(point.value for point in points),
                data=points,
            )
        )
    return latest_version, versions, series


async def _resolve_version_gate(
    session: AsyncSession,
    scan_config_id: uuid.UUID | None,
    project_keep_releases: int,
) -> tuple[int, re.Pattern[str] | None, float]:
    """Resolve the shared retention plus source-specific version gates.

    Retention is project-wide. Prerelease and activation-share gates remain
    per scan when the metric is aligned to one; standalone SQL/fact metrics use
    their existing defaults for those two gates.
    """
    if scan_config_id is not None:
        row = (
            await session.execute(
                select(
                    ScanConfig.app_version_prerelease_pattern,
                    ScanConfig.app_version_active_share_min,
                ).where(ScanConfig.id == scan_config_id)
            )
        ).first()
        if row is not None:
            pattern, share = row
            return (
                project_keep_releases,
                compile_prerelease_pattern(pattern),
                resolve_share_min(share),
            )
    return project_keep_releases, None, DEFAULT_ACTIVE_SHARE_MIN


async def _metric_source_data_source_id(
    session: AsyncSession,
    project_id: uuid.UUID,
    metric: MetricDefinition,
    scan_config_id: uuid.UUID | None,
) -> uuid.UUID | None:
    """Resolve the data source whose project total defines metric release maturity."""
    if scan_config_id is not None:
        return cast(
            uuid.UUID | None,
            await session.scalar(
                select(ScanConfig.data_source_id).where(
                    ScanConfig.id == scan_config_id,
                    ScanConfig.project_id == project_id,
                )
            ),
        )
    if metric.data_source_id is not None:
        return metric.data_source_id
    if metric.fact_table_id is not None:
        return cast(
            uuid.UUID | None,
            await session.scalar(
                select(FactTable.data_source_id).where(
                    FactTable.id == metric.fact_table_id,
                    FactTable.project_id == project_id,
                )
            ),
        )
    return None


async def _load_project_version_maturity_rows(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    scan_config_id: uuid.UUID | None,
    time_from: datetime | None,
    time_to: datetime | None,
) -> dict[tuple[str, bool], list[tuple[datetime, float]]]:
    """Load project-total version traffic from one canonical scan."""
    if scan_config_id is None:
        return {}

    query = (
        select(
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            EventMetricBreakdown.bucket,
            func.sum(EventMetricBreakdown.count),
        )
        .join(ScanConfig, EventMetricBreakdown.scan_config_id == ScanConfig.id)
        .where(
            ScanConfig.id == scan_config_id,
            ScanConfig.project_id == project_id,
            ScanConfig.app_version_column.is_not(None),
            EventMetricBreakdown.breakdown_column == ScanConfig.app_version_column,
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id.is_not(None),
        )
        .group_by(
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            EventMetricBreakdown.bucket,
        )
        .order_by(EventMetricBreakdown.bucket)
    )
    if time_from is not None:
        query = query.where(EventMetricBreakdown.bucket >= time_from)
    if time_to is not None:
        query = query.where(EventMetricBreakdown.bucket < time_to)

    rows_by_series: dict[tuple[str, bool], list[tuple[datetime, float]]] = {}
    for version, is_other, bucket, count in (await session.execute(query)).all():
        rows_by_series.setdefault((str(version), bool(is_other)), []).append((bucket, float(count)))
    return rows_by_series


async def _resolve_maturity_scan_config_id(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    data_source_id: uuid.UUID | None,
    metric_scan_config_id: uuid.UUID | None,
    time_from: datetime | None,
    time_to: datetime | None,
) -> uuid.UUID | None:
    """Resolve one scan whose project total defines a metric's rollout state.

    Metrics aligned to a scan always reuse that exact scan. Standalone SQL/fact
    metrics choose the source scan with the largest project-total volume in the
    requested window, which avoids mixing overlapping scans or bucket grids.
    """
    if metric_scan_config_id is not None:
        return cast(
            uuid.UUID | None,
            await session.scalar(
                select(ScanConfig.id).where(
                    ScanConfig.id == metric_scan_config_id,
                    ScanConfig.project_id == project_id,
                    ScanConfig.app_version_column.is_not(None),
                )
            ),
        )
    if data_source_id is None:
        return None

    query = (
        select(ScanConfig.id)
        .join(EventMetricBreakdown, EventMetricBreakdown.scan_config_id == ScanConfig.id)
        .where(
            ScanConfig.project_id == project_id,
            ScanConfig.data_source_id == data_source_id,
            ScanConfig.app_version_column.is_not(None),
            EventMetricBreakdown.breakdown_column == ScanConfig.app_version_column,
            EventMetricBreakdown.event_id.is_(None),
            EventMetricBreakdown.event_type_id.is_not(None),
        )
        .group_by(ScanConfig.id)
        .order_by(func.sum(EventMetricBreakdown.count).desc(), ScanConfig.id)
        .limit(1)
    )
    if time_from is not None:
        query = query.where(EventMetricBreakdown.bucket >= time_from)
    if time_to is not None:
        query = query.where(EventMetricBreakdown.bucket < time_to)
    return cast(uuid.UUID | None, await session.scalar(query))


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
    maturity_scan_config_id = await _resolve_maturity_scan_config_id(
        session,
        project_id=project.id,
        data_source_id=await _metric_source_data_source_id(
            session,
            project.id,
            metric,
            scan_config_id,
        ),
        metric_scan_config_id=scan_config_id,
        time_from=time_from,
        time_to=time_to,
    )
    maturity_rows_by_series = await _load_project_version_maturity_rows(
        session,
        project_id=project.id,
        scan_config_id=maturity_scan_config_id,
        time_from=time_from,
        time_to=time_to,
    )
    keep_releases, prerelease_pattern, share_min = await _resolve_version_gate(
        session,
        maturity_scan_config_id,
        project.app_version_keep_releases,
    )
    latest_version, versions, series = _build_metric_version_series(
        interval=interval,
        value_rows_by_series=value_rows_by_series,
        maturity_rows_by_series=maturity_rows_by_series,
        keep_releases=keep_releases,
        count_shaped=is_count_shaped(metric),
        prerelease_pattern=prerelease_pattern,
        share_min=share_min,
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
