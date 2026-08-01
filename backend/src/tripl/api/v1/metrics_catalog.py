import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from tripl.api.deps import EditorUserDep, SessionDep, get_editor_user
from tripl.models.domain_enums import MetricKind, MetricStatus
from tripl.models.metric_definition import MetricDefinition
from tripl.schemas.metric_definition import (
    FactOperand,
    FactOperandPreviewResponse,
    MetricCollectNowResponse,
    MetricDefinitionBulkUpdate,
    MetricDefinitionCreate,
    MetricDefinitionDetailResponse,
    MetricDefinitionListResponse,
    MetricDefinitionMove,
    MetricDefinitionReorder,
    MetricDefinitionResponse,
    MetricDefinitionUpdate,
    MetricGeneratedSqlResponse,
    MetricPreviewRequest,
    MetricPreviewResponse,
)
from tripl.schemas.metric_series import (
    MetricBreakdownsResponse,
    MetricSeriesResponse,
    MetricVersionSeriesResponse,
)
from tripl.schemas.text_filters import FreeTextFilter
from tripl.services import (
    audit_service,
    metric_definition_service,
    metric_preview_service,
    metric_series_service,
)

router = APIRouter(prefix="/projects/{slug}/metrics", tags=["metrics-catalog"])
_editor_required = [Depends(get_editor_user)]

TimeFrom = Annotated[datetime | None, Query(alias="from")]
TimeTo = Annotated[datetime | None, Query(alias="to")]


@router.get("", response_model=MetricDefinitionListResponse)
async def list_metric_definitions(
    session: SessionDep,
    slug: str,
    status: Annotated[list[MetricStatus] | None, Query()] = None,
    kind: MetricKind | None = None,
    # FreeTextFilter: binds into an ILIKE, so a NUL aborts inside asyncpg
    # before SQL runs (tripl-8wez).
    search: FreeTextFilter | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
) -> MetricDefinitionListResponse:
    items, total = await metric_definition_service.list_metric_definitions_enriched(
        session,
        slug,
        status=status,
        kind=kind,
        search=search,
        offset=offset,
        limit=limit,
    )
    active_total = await metric_definition_service.count_active_metric_definitions(
        session, slug, kind=kind, search=search
    )
    return MetricDefinitionListResponse(items=items, total=total, active_total=active_total)


@router.post(
    "",
    response_model=MetricDefinitionResponse,
    status_code=201,
)
async def create_metric_definition(
    session: SessionDep,
    slug: str,
    data: MetricDefinitionCreate,
    current_user: EditorUserDep,
) -> MetricDefinition:
    metric = await metric_definition_service.create_metric_definition(session, slug, data)
    await audit_service.record(
        session,
        user=current_user,
        action="metric_definition.create",
        target_type="metric_definition",
        target_id=metric.id,
        target_name=metric.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return metric


@router.post("/bulk-update", status_code=204, dependencies=_editor_required)
async def bulk_update_metric_definitions(
    session: SessionDep,
    slug: str,
    data: MetricDefinitionBulkUpdate,
) -> None:
    await metric_definition_service.bulk_update_metric_definitions(session, slug, data)


@router.post(
    "/preview",
    response_model=MetricPreviewResponse,
    dependencies=_editor_required,
)
async def preview_metric_sql(
    session: SessionDep,
    slug: str,
    data: MetricPreviewRequest,
) -> MetricPreviewResponse:
    """Stateless dry-run of a sql-kind metric SELECT (editor-gated).

    Validates the SQL with the same safety gate the worker uses and executes it
    against the data source over the last 50 buckets of the requested interval
    (hard-capped at 200 rows); nothing is persisted. Expected user mistakes —
    bad SQL, missing time/value columns, warehouse errors — return 200 with
    ``error`` set so the editor can render them inline; unknown data source is
    a 404.
    """
    return await metric_preview_service.preview_sql_metric(session, slug, data)


@router.post(
    "/fact-preview",
    response_model=FactOperandPreviewResponse,
    dependencies=_editor_required,
)
async def preview_fact_operand(
    session: SessionDep,
    slug: str,
    data: FactOperand,
) -> FactOperandPreviewResponse:
    """Stateless dry-run of ONE fact operand's row filter (editor-gated).

    The body is the operand a save would send. Its filters are compiled by the
    worker's own resolver for the fact table's data-source dialect and the
    resulting query is executed with a 1-row cap over a bounded recent window;
    nothing is persisted. Expected user mistakes — an unknown named filter, SQL
    the warehouse rejects, a measure column the filtered query does not project —
    return 200 with ``error`` set so the filter editor can render them inline.
    An unknown project or fact table is a 404.
    """
    return await metric_preview_service.preview_fact_operand(session, slug, data)


@router.patch(
    "/reorder",
    response_model=list[MetricDefinitionResponse],
    dependencies=_editor_required,
)
async def reorder_metric_definitions(
    session: SessionDep,
    slug: str,
    data: MetricDefinitionReorder,
) -> list[MetricDefinition]:
    return await metric_definition_service.reorder_metric_definitions(session, slug, data)


@router.get("/{metric_id}", response_model=MetricDefinitionDetailResponse)
async def get_metric_definition(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
) -> MetricDefinitionDetailResponse:
    return await metric_definition_service.get_metric_definition_enriched(session, slug, metric_id)


@router.get(
    "/{metric_id}/generated-sql",
    response_model=MetricGeneratedSqlResponse,
)
async def get_metric_generated_sql(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
) -> MetricGeneratedSqlResponse:
    """Return a saved fact metric's primary dependency-batch SQL without running it."""
    return await metric_preview_service.get_saved_fact_metric_sql(
        session,
        slug,
        metric_id,
    )


# Series reads live under the two-segment ``/{metric_id}/...`` templates, which
# never overlap the single-segment ``/{metric_id}`` CRUD route or the static
# ``/reorder`` / ``/bulk-update`` routes.
@router.get("/{metric_id}/series", response_model=MetricSeriesResponse)
async def get_metric_series(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> MetricSeriesResponse:
    return await metric_series_service.get_metric_series(
        session,
        slug,
        metric_id,
        time_from=time_from,
        time_to=time_to,
    )


@router.get("/{metric_id}/breakdowns", response_model=MetricBreakdownsResponse)
async def get_metric_breakdowns(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
    column: FreeTextFilter | None = None,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> MetricBreakdownsResponse:
    return await metric_series_service.get_metric_breakdowns(
        session,
        slug,
        metric_id,
        column=column,
        time_from=time_from,
        time_to=time_to,
    )


@router.get("/{metric_id}/versions", response_model=MetricVersionSeriesResponse)
async def get_metric_version_series(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
    time_from: TimeFrom = None,
    time_to: TimeTo = None,
) -> MetricVersionSeriesResponse:
    return await metric_series_service.get_metric_version_series(
        session,
        slug,
        metric_id,
        time_from=time_from,
        time_to=time_to,
    )


@router.post(
    "/{metric_id}/collect",
    response_model=MetricCollectNowResponse,
    status_code=202,
)
async def collect_metric_now(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
    current_user: EditorUserDep,
) -> MetricCollectNowResponse:
    """Trigger an immediate backfill collection from one metric (editor-gated).

    SQL/event-composition metrics dispatch alone. A fact metric refreshes every
    fact table reachable through its operands and recalculates all active fact
    metrics using those tables in shared batches (the clicked metric is included
    even when draft). Returns 202 once queued; warehouse queries run in workers.
    Unknown metric -> 404.
    """
    result = await metric_definition_service.trigger_metric_collection(session, slug, metric_id)
    await audit_service.record(
        session,
        user=current_user,
        action="metric_definition.collect",
        target_type="metric_definition",
        target_id=metric_id,
        project_slug=slug,
        payload={
            "window_from": result.window_from.isoformat() if result.window_from else None,
            "window_to": result.window_to.isoformat() if result.window_to else None,
        },
    )
    return result


@router.patch("/{metric_id}", response_model=MetricDefinitionResponse)
async def update_metric_definition(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
    data: MetricDefinitionUpdate,
    current_user: EditorUserDep,
) -> MetricDefinition:
    metric = await metric_definition_service.update_metric_definition(
        session, slug, metric_id, data
    )
    await audit_service.record(
        session,
        user=current_user,
        action="metric_definition.update",
        target_type="metric_definition",
        target_id=metric.id,
        target_name=metric.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return metric


@router.patch(
    "/{metric_id}/move",
    response_model=MetricDefinitionResponse,
    dependencies=_editor_required,
)
async def move_metric_definition(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
    data: MetricDefinitionMove,
) -> MetricDefinition:
    return await metric_definition_service.move_metric_definition(session, slug, metric_id, data)


@router.delete("/{metric_id}", status_code=204)
async def delete_metric_definition(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    existing = await metric_definition_service.get_metric_definition(session, slug, metric_id)
    name = existing.name
    await metric_definition_service.delete_metric_definition(session, slug, metric_id)
    await audit_service.record(
        session,
        user=current_user,
        action="metric_definition.delete",
        target_type="metric_definition",
        target_id=metric_id,
        target_name=name,
        project_slug=slug,
    )
