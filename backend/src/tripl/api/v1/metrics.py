import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from tripl.api.deps import SessionDep
from tripl.schemas.event_metric import (
    ActiveSignalsQuery,
    BreakdownTimelineResponse,
    DistributionDriftsResponse,
    EventMetricBreakdownsResponse,
    EventMetricsResponse,
    EventWindowMetricsRequest,
    EventWindowMetricsResponse,
    MetricSignalResponse,
    SeasonalityHeatmapResponse,
    TopMoverItem,
)
from tripl.services import metrics_insights_service, metrics_service

router = APIRouter(tags=["metrics"])

TimeFrom = Annotated[datetime | None, Query(alias="from")]
TimeTo = Annotated[datetime | None, Query(alias="to")]
EventIds = Annotated[list[uuid.UUID] | None, Query(alias="event_id")]


@router.get(
    "/projects/{slug}/events-metrics",
    response_model=EventMetricsResponse,
)
async def get_events_metrics(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID | None = None,
    search: str | None = None,
    implemented: bool | None = None,
    tag: str | None = None,
    reviewed: bool | None = None,
    archived: bool | None = None,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> EventMetricsResponse:
    return await metrics_service.get_events_metrics(
        session,
        slug,
        event_type_id=event_type_id,
        search=search,
        implemented=implemented,
        tag=tag,
        reviewed=reviewed,
        archived=archived,
        time_from=time_from,
        time_to=time_to,
    )


@router.post(
    "/projects/{slug}/events/window-metrics",
    response_model=list[EventWindowMetricsResponse],
)
async def get_events_window_metrics(
    session: SessionDep,
    slug: str,
    data: EventWindowMetricsRequest,
) -> list[EventWindowMetricsResponse]:
    return await metrics_service.get_events_window_metrics(
        session,
        slug,
        event_ids=data.event_ids,
        time_from=data.time_from,
        time_to=data.time_to,
    )


@router.get(
    "/projects/{slug}/metrics/total",
    response_model=EventMetricsResponse,
)
async def get_project_total_metrics(
    session: SessionDep,
    slug: str,
    scan_config_id: uuid.UUID | None = None,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> EventMetricsResponse:
    return await metrics_service.get_project_total_metrics(
        session,
        slug,
        scan_config_id=scan_config_id,
        time_from=time_from,
        time_to=time_to,
    )


@router.get(
    "/projects/{slug}/events/{event_id}/metrics",
    response_model=EventMetricsResponse,
)
async def get_event_metrics(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> EventMetricsResponse:
    return await metrics_service.get_event_metrics(session, slug, event_id, time_from, time_to)


@router.get(
    "/projects/{slug}/events/{event_id}/metrics/breakdowns",
    response_model=EventMetricBreakdownsResponse,
)
async def get_event_metric_breakdowns(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    column: str | None = None,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> EventMetricBreakdownsResponse:
    return await metrics_service.get_event_metric_breakdowns(
        session,
        slug,
        event_id,
        column=column,
        time_from=time_from,
        time_to=time_to,
    )


@router.get(
    "/projects/{slug}/event-types/{event_type_id}/metrics",
    response_model=EventMetricsResponse,
)
async def get_event_type_metrics(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> EventMetricsResponse:
    return await metrics_service.get_event_type_metrics(
        session, slug, event_type_id, time_from, time_to
    )


@router.get(
    "/projects/{slug}/anomalies/signals",
    response_model=list[MetricSignalResponse],
)
async def get_active_signals(
    session: SessionDep,
    slug: str,
    event_ids: EventIds = None,
) -> list[MetricSignalResponse]:
    """Cacheable no-args variant. For filtering by a large event-id list
    (>>a few), prefer ``POST /anomalies/signals/query`` — GET's query-string
    overflow is real once you cross ~50 ids (proxy/browser limits)."""
    return await metrics_insights_service.get_active_signals(session, slug, event_ids=event_ids)


@router.post(
    "/projects/{slug}/anomalies/signals/query",
    response_model=list[MetricSignalResponse],
)
async def query_active_signals(
    session: SessionDep,
    slug: str,
    data: ActiveSignalsQuery,
) -> list[MetricSignalResponse]:
    return await metrics_insights_service.get_active_signals(
        session, slug, event_ids=data.event_ids or None
    )


@router.get(
    "/projects/{slug}/scans/{scan_config_id}/top-movers",
    response_model=list[TopMoverItem],
)
async def get_top_movers(
    session: SessionDep,
    slug: str,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    bucket: datetime,
    limit: int = 10,
) -> list[TopMoverItem]:
    """Top-N breakdown rows that "moved" a given anomaly bucket, |z| desc."""
    return await metrics_insights_service.get_top_movers(
        session,
        slug,
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        bucket=bucket,
        limit=limit,
    )


@router.get(
    "/projects/{slug}/scans/{scan_config_id}/seasonality",
    response_model=SeasonalityHeatmapResponse,
)
async def get_seasonality_heatmap(
    session: SessionDep,
    slug: str,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> SeasonalityHeatmapResponse:
    """7×24 hour-of-day × weekday heatmap of volume and anomaly density."""
    return await metrics_insights_service.get_seasonality_heatmap(
        session,
        slug,
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        time_from=time_from,
        time_to=time_to,
    )


@router.get(
    "/projects/{slug}/scans/{scan_config_id}/breakdown-timeline",
    response_model=BreakdownTimelineResponse,
)
async def get_breakdown_timeline(
    session: SessionDep,
    slug: str,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    breakdown_column: str,
    breakdown_value: str,
    is_other: bool = False,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> BreakdownTimelineResponse:
    """Per-bucket count timeline for one breakdown_value (drill-down)."""
    return await metrics_insights_service.get_breakdown_timeline(
        session,
        slug,
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        breakdown_column=breakdown_column,
        breakdown_value=breakdown_value,
        is_other=is_other,
        time_from=time_from,
        time_to=time_to,
    )


@router.get(
    "/projects/{slug}/distribution-drifts",
    response_model=DistributionDriftsResponse,
)
async def get_distribution_drifts(
    session: SessionDep,
    slug: str,
    scope_type: str,
    scope_ref: str,
    scan_config_id: uuid.UUID | None = None,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> DistributionDriftsResponse:
    return await metrics_insights_service.get_distribution_drifts(
        session,
        slug,
        scope_type=scope_type,
        scope_ref=scope_ref,
        scan_config_id=scan_config_id,
        time_from=time_from,
        time_to=time_to,
    )
