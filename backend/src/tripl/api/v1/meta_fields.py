import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from tripl.api.deps import CurrentUserDep, SessionDep
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.schemas.meta_field import MetaFieldCreate, MetaFieldResponse, MetaFieldUpdate
from tripl.services import audit_service, meta_field_service

router = APIRouter(prefix="/projects/{slug}/meta-fields", tags=["meta-fields"])


@router.get("", response_model=list[MetaFieldResponse])
async def list_meta_fields(session: SessionDep, slug: str) -> list[MetaFieldResponse]:
    return await meta_field_service.list_meta_fields(session, slug)


@router.post("", response_model=MetaFieldResponse, status_code=201)
async def create_meta_field(
    session: SessionDep,
    slug: str,
    data: MetaFieldCreate,
    current_user: CurrentUserDep,
) -> MetaFieldDefinition:
    mf = await meta_field_service.create_meta_field(session, slug, data)
    await audit_service.record(
        session,
        user=current_user,
        action="meta_field.create",
        target_type="meta_field",
        target_id=mf.id,
        target_name=mf.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return mf


@router.patch("/{meta_field_id}", response_model=MetaFieldResponse)
async def update_meta_field(
    session: SessionDep,
    slug: str,
    meta_field_id: uuid.UUID,
    data: MetaFieldUpdate,
    current_user: CurrentUserDep,
) -> MetaFieldDefinition:
    mf = await meta_field_service.update_meta_field(session, slug, meta_field_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="meta_field.update",
        target_type="meta_field",
        target_id=mf.id,
        target_name=mf.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return mf


@router.delete("/{meta_field_id}", status_code=204)
async def delete_meta_field(
    session: SessionDep,
    slug: str,
    meta_field_id: uuid.UUID,
    current_user: CurrentUserDep,
) -> None:
    existing = await session.scalar(
        select(MetaFieldDefinition).where(MetaFieldDefinition.id == meta_field_id)
    )
    if existing is None:
        raise HTTPException(status_code=404, detail="Meta field not found")
    name = existing.name
    await meta_field_service.delete_meta_field(session, slug, meta_field_id)
    await audit_service.record(
        session,
        user=current_user,
        action="meta_field.delete",
        target_type="meta_field",
        target_id=meta_field_id,
        target_name=name,
        project_slug=slug,
    )
