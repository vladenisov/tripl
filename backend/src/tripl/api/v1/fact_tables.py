import uuid

from fastapi import APIRouter, Depends, HTTPException, Query

from tripl.api.deps import EditorUserDep, SessionDep, get_editor_user
from tripl.models.fact_table import FactTable
from tripl.schemas.fact_table import (
    FactTableColumnSchema,
    FactTableCreate,
    FactTableListItem,
    FactTableListResponse,
    FactTablePreviewRequest,
    FactTablePreviewResponse,
    FactTableResponse,
    FactTableUpdate,
)
from tripl.services import audit_service, fact_table_service
from tripl.services.project_lookup import get_project_id_by_slug

router = APIRouter(prefix="/projects/{slug}/fact-tables", tags=["fact-tables"])
_editor_required = [Depends(get_editor_user)]


@router.get("", response_model=FactTableListResponse)
async def list_fact_tables(
    session: SessionDep,
    slug: str,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=1000),
) -> FactTableListResponse:
    items, total = await fact_table_service.list_fact_tables(
        session,
        slug,
        search=search,
        offset=offset,
        limit=limit,
    )
    return FactTableListResponse(
        items=[FactTableListItem.model_validate(item) for item in items],
        total=total,
    )


@router.post("", response_model=FactTableResponse, status_code=201)
async def create_fact_table(
    session: SessionDep,
    slug: str,
    data: FactTableCreate,
    current_user: EditorUserDep,
) -> FactTable:
    fact_table = await fact_table_service.create_fact_table(session, slug, data)
    await audit_service.record(
        session,
        user=current_user,
        action="fact_table.create",
        target_type="fact_table",
        target_id=fact_table.id,
        target_name=fact_table.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return fact_table


# Declared before the parametric ``/{fact_table_id}`` routes so the static
# ``/preview`` path is never shadowed.
@router.post("/preview", response_model=FactTablePreviewResponse, dependencies=_editor_required)
async def preview_fact_table(
    session: SessionDep,
    slug: str,
    payload: FactTablePreviewRequest,
) -> FactTablePreviewResponse:
    # Imported lazily: the introspection service is a sibling slice and may land
    # after this router. A function-local import keeps the app importable even
    # before that module exists on disk.
    from tripl.services.fact_table_introspection_service import (
        FactTableIntrospectionError,
        introspect_fact_table,
    )

    project_id = await get_project_id_by_slug(session, slug)
    try:
        result = await introspect_fact_table(
            session,
            project_id=project_id,
            data_source_id=payload.data_source_id,
            sql=payload.sql,
            timestamp_column=payload.timestamp_column,
        )
    except FactTableIntrospectionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    columns = [
        FactTableColumnSchema(
            name=column.name,
            type=column.type,
            native_type=column.native_type,
        )
        for column in result.columns
    ]
    return FactTablePreviewResponse(
        columns=columns,
        identifier_candidates=list(result.identifier_candidates),
        sample_rows=list(result.sample_rows),
    )


@router.get("/{fact_table_id}", response_model=FactTableResponse)
async def get_fact_table(
    session: SessionDep,
    slug: str,
    fact_table_id: uuid.UUID,
) -> FactTable:
    return await fact_table_service.get_fact_table(session, slug, fact_table_id)


@router.patch("/{fact_table_id}", response_model=FactTableResponse)
async def update_fact_table(
    session: SessionDep,
    slug: str,
    fact_table_id: uuid.UUID,
    data: FactTableUpdate,
    current_user: EditorUserDep,
) -> FactTable:
    fact_table = await fact_table_service.update_fact_table(session, slug, fact_table_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="fact_table.update",
        target_type="fact_table",
        target_id=fact_table.id,
        target_name=fact_table.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return fact_table


@router.delete("/{fact_table_id}", status_code=204)
async def delete_fact_table(
    session: SessionDep,
    slug: str,
    fact_table_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    existing = await fact_table_service.get_fact_table(session, slug, fact_table_id)
    name = existing.name
    await fact_table_service.delete_fact_table(session, slug, fact_table_id)
    await audit_service.record(
        session,
        user=current_user,
        action="fact_table.delete",
        target_type="fact_table",
        target_id=fact_table_id,
        target_name=name,
        project_slug=slug,
    )
