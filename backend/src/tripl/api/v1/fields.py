import uuid

from fastapi import APIRouter

from tripl.api.deps import CurrentUserDep, SessionDep
from tripl.models.field_definition import FieldDefinition
from tripl.schemas.field_definition import (
    FieldDefinitionCreate,
    FieldDefinitionResponse,
    FieldDefinitionUpdate,
    FieldReorder,
)
from tripl.services import audit_service, field_service

router = APIRouter(prefix="/projects/{slug}/event-types/{event_type_id}/fields", tags=["fields"])


@router.get("", response_model=list[FieldDefinitionResponse])
async def list_fields(
    session: SessionDep, slug: str, event_type_id: uuid.UUID
) -> list[FieldDefinition]:
    return await field_service.list_fields(session, slug, event_type_id)


@router.post("", response_model=FieldDefinitionResponse, status_code=201)
async def create_field(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    data: FieldDefinitionCreate,
    current_user: CurrentUserDep,
) -> FieldDefinition:
    field = await field_service.create_field(session, slug, event_type_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="field.create",
        target_type="field_definition",
        target_id=field.id,
        target_name=field.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return field


@router.patch("/reorder", response_model=list[FieldDefinitionResponse])
async def reorder_fields(
    session: SessionDep, slug: str, event_type_id: uuid.UUID, data: FieldReorder
) -> list[FieldDefinition]:
    return await field_service.reorder_fields(session, slug, event_type_id, data)


@router.patch("/{field_id}", response_model=FieldDefinitionResponse)
async def update_field(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    field_id: uuid.UUID,
    data: FieldDefinitionUpdate,
    current_user: CurrentUserDep,
) -> FieldDefinition:
    field = await field_service.update_field(session, slug, event_type_id, field_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="field.update",
        target_type="field_definition",
        target_id=field.id,
        target_name=field.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return field


@router.delete("/{field_id}", status_code=204)
async def delete_field(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    field_id: uuid.UUID,
    current_user: CurrentUserDep,
) -> None:
    fields = await field_service.list_fields(session, slug, event_type_id)
    name = next((f.name for f in fields if f.id == field_id), "")
    await field_service.delete_field(session, slug, event_type_id, field_id)
    await audit_service.record(
        session,
        user=current_user,
        action="field.delete",
        target_type="field_definition",
        target_id=field_id,
        target_name=name,
        project_slug=slug,
    )
