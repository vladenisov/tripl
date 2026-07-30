"""API for chart annotations (deploy/release markers on metric charts)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from tripl.api.deps import EditorUserDep, SessionDep
from tripl.models.domain_enums import ChartAnnotationScopeType
from tripl.schemas.chart_annotation import ChartAnnotationCreate, ChartAnnotationResponse
from tripl.services import chart_annotation_service

router = APIRouter(
    prefix="/projects/{slug}/annotations",
    tags=["chart-annotations"],
)

OptionalDateTimeQuery = Annotated[datetime | None, Query()]


@router.get("", response_model=list[ChartAnnotationResponse])
async def list_chart_annotations(
    session: SessionDep,
    slug: str,
    # ChartAnnotationScopeType (not str): the filter binds against the native
    # ``chart_annotation_scope_type`` column, so an out-of-enum value reached the
    # driver as a 500. Note this is the annotation scope enum, NOT MetricScopeType
    # — annotations only ever hang off project_total/event_type/event/metric,
    # which is exactly what the POST body already validates (tripl-57g0). Moved
    # into Annotated[] because ruff's B008 only exempts call-defaults whose
    # annotation it can prove immutable, and an enum class isn't on that list.
    scope_type: Annotated[ChartAnnotationScopeType | None, Query()] = None,
    scope_ref: str | None = Query(default=None),
    time_from: OptionalDateTimeQuery = None,
    time_to: OptionalDateTimeQuery = None,
) -> list[ChartAnnotationResponse]:
    rows = await chart_annotation_service.list_annotations(
        session,
        slug,
        scope_type=scope_type,
        scope_ref=scope_ref,
        time_from=time_from,
        time_to=time_to,
    )
    return [ChartAnnotationResponse.model_validate(row) for row in rows]


@router.post("", response_model=ChartAnnotationResponse, status_code=201)
async def create_chart_annotation(
    session: SessionDep,
    slug: str,
    data: ChartAnnotationCreate,
    current_user: EditorUserDep,
) -> ChartAnnotationResponse:
    annotation = await chart_annotation_service.create_annotation(
        session,
        slug,
        bucket=data.bucket,
        label=data.label,
        description=data.description,
        color=data.color,
        scope_type=data.scope_type,
        scope_ref=data.scope_ref,
        user_id=current_user.id,
    )
    return ChartAnnotationResponse.model_validate(annotation)


@router.delete("/{annotation_id}", status_code=204)
async def delete_chart_annotation(
    session: SessionDep,
    slug: str,
    annotation_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    del current_user
    await chart_annotation_service.delete_annotation(session, slug, annotation_id)
