import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from tripl.api.deps import EditorUserDep, SessionDep, get_editor_user
from tripl.models.domain_enums import MetricKind, MetricStatus
from tripl.models.metric_definition import MetricDefinition
from tripl.schemas.metric_definition import (
    MetricDefinitionBulkUpdate,
    MetricDefinitionCreate,
    MetricDefinitionListResponse,
    MetricDefinitionMove,
    MetricDefinitionReorder,
    MetricDefinitionResponse,
    MetricDefinitionUpdate,
)
from tripl.services import audit_service, metric_definition_service

router = APIRouter(prefix="/projects/{slug}/metrics", tags=["metrics-catalog"])
_editor_required = [Depends(get_editor_user)]


@router.get("", response_model=MetricDefinitionListResponse)
async def list_metric_definitions(
    session: SessionDep,
    slug: str,
    status: Annotated[list[MetricStatus] | None, Query()] = None,
    kind: MetricKind | None = None,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
) -> MetricDefinitionListResponse:
    items, total = await metric_definition_service.list_metric_definitions(
        session,
        slug,
        status=status,
        kind=kind,
        search=search,
        offset=offset,
        limit=limit,
    )
    return MetricDefinitionListResponse(items=items, total=total)


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


@router.get("/{metric_id}", response_model=MetricDefinitionResponse)
async def get_metric_definition(
    session: SessionDep,
    slug: str,
    metric_id: uuid.UUID,
) -> MetricDefinition:
    return await metric_definition_service.get_metric_definition(session, slug, metric_id)


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
