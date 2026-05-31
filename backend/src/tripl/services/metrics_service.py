"""Service for querying event metrics and anomaly signals from PostgreSQL."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_tag import EventTag
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.schemas.event_metric import (
    EventMetricBreakdownSeries,
    EventMetricBreakdownsResponse,
    EventMetricPoint,
    EventMetricsResponse,
    EventWindowMetricsResponse,
    ForecastPoint,
    MetricSignalResponse,
)
from tripl.services.monitoring_utils import classify_signal_state
from tripl.services.project_lookup import get_project_by_slug
from tripl.worker.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
    SeriesPoint,
    expand_series,
    forecast_next_buckets,
)
from tripl.worker.utils.intervals import get_interval


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


async def _get_project_interval(session: AsyncSession, project_id: uuid.UUID) -> str | None:
    result = await session.execute(
        select(ScanConfig.interval)
        .where(
            ScanConfig.project_id == project_id,
            ScanConfig.interval.isnot(None),
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


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


def _build_metric_points(
    *,
    interval: str | None,
    metric_rows: list[tuple[datetime, int]],
    anomalies: list[MetricAnomaly] | list[MetricBreakdownAnomaly],
) -> list[EventMetricPoint]:
    counts_by_bucket = {bucket: count for bucket, count in metric_rows}
    anomalies_by_bucket = {anomaly.bucket: anomaly for anomaly in anomalies}

    for anomaly in anomalies:
        counts_by_bucket.setdefault(anomaly.bucket, anomaly.actual_count)

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
                    anomalies_by_bucket[point.bucket].stddev
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
                    anomalies_by_bucket[bucket].stddev if bucket in anomalies_by_bucket else None
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
    return _build_metrics_response(
        scope=SCOPE_EVENT,
        scan_config_id=scan_config_id,
        scope_ref=str(event.id),
        interval=interval,
        metric_rows=metric_rows,
        anomalies=anomalies,
        event_id=event.id,
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
    for anomaly in (await session.execute(anomaly_query)).scalars():
        key = (anomaly.breakdown_value, anomaly.is_other)
        anomalies_by_series.setdefault(key, []).append(anomaly)

    series: list[EventMetricBreakdownSeries] = []
    for key in set(metric_rows_by_series) | set(anomalies_by_series):
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


async def get_events_metrics(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID | None = None,
    search: str | None = None,
    implemented: bool | None = None,
    tag: str | None = None,
    reviewed: bool | None = None,
    archived: bool | None = None,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> EventMetricsResponse:
    project = await _resolve_project(session, slug)

    query = (
        select(EventMetric.bucket, func.sum(EventMetric.count))
        .join(Event, EventMetric.event_id == Event.id)
        .where(
            Event.project_id == project.id,
            EventMetric.event_id.is_not(None),
        )
    )

    if event_type_id:
        query = query.where(Event.event_type_id == event_type_id)
    if search:
        query = query.where(Event.name.ilike(f"%{search}%"))
    if implemented is not None:
        query = query.where(Event.implemented == implemented)
    if reviewed is not None:
        query = query.where(Event.reviewed == reviewed)
    if archived is not None:
        query = query.where(Event.archived == archived)
    if tag:
        tagged_event_ids = select(EventTag.event_id).where(EventTag.name == tag).correlate(None)
        query = query.where(Event.id.in_(tagged_event_ids))
    if time_from:
        query = query.where(EventMetric.bucket >= time_from)
    if time_to:
        query = query.where(EventMetric.bucket < time_to)

    result = await session.execute(query.group_by(EventMetric.bucket).order_by(EventMetric.bucket))
    rows = [(bucket, int(count)) for bucket, count in result.all()]

    interval = await _get_project_interval(session, project.id) if rows else None

    return EventMetricsResponse(
        scope="events_total",
        interval=interval,
        data=[EventMetricPoint(bucket=bucket, count=count) for bucket, count in rows],
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
    return _build_metrics_response(
        scope=SCOPE_EVENT_TYPE,
        scan_config_id=scan_config_id,
        scope_ref=str(event_type.id),
        interval=interval,
        metric_rows=metric_rows,
        anomalies=anomalies,
        event_type_id=event_type.id,
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
    )
