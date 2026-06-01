import uuid

from fastapi import APIRouter, Depends

from tripl.api.deps import BranchIdDep, EditorUserDep, SessionDep, get_editor_user
from tripl.models.field_definition import FieldDefinition
from tripl.schemas.field_definition import (
    FieldDefinitionBulkCreate,
    FieldDefinitionCreate,
    FieldDefinitionResponse,
    FieldDefinitionUpdate,
    FieldReorder,
)
from tripl.services import audit_service, field_service

router = APIRouter(prefix="/projects/{slug}/event-types/{event_type_id}/fields", tags=["fields"])
_editor_required = [Depends(get_editor_user)]


@router.get("", response_model=list[FieldDefinitionResponse])
async def list_fields(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    branch_id: BranchIdDep,
) -> list[FieldDefinition]:
    return await field_service.list_fields(session, slug, event_type_id, branch_id)


@router.post("", response_model=FieldDefinitionResponse, status_code=201)
async def create_field(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    data: FieldDefinitionCreate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> FieldDefinition:
    field = await field_service.create_field(session, slug, event_type_id, data, branch_id)
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


@router.post("/bulk", response_model=list[FieldDefinitionResponse], status_code=201)
async def bulk_create_fields(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    data: FieldDefinitionBulkCreate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> list[FieldDefinition]:
    before = await field_service.list_fields(session, slug, event_type_id, branch_id)
    before_names = {f.name for f in before}
    fields = await field_service.bulk_create_fields(session, slug, event_type_id, data, branch_id)
    created = [f for f in fields if f.name not in before_names]
    for field in created:
        await audit_service.record(
            session,
            user=current_user,
            action="field.create",
            target_type="field_definition",
            target_id=field.id,
            target_name=field.name,
            project_slug=slug,
        )
    return fields


@router.patch(
    "/reorder",
    response_model=list[FieldDefinitionResponse],
    dependencies=_editor_required,
)
async def reorder_fields(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    data: FieldReorder,
    branch_id: BranchIdDep,
) -> list[FieldDefinition]:
    return await field_service.reorder_fields(session, slug, event_type_id, data, branch_id)


@router.patch("/{field_id}", response_model=FieldDefinitionResponse)
async def update_field(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    field_id: uuid.UUID,
    data: FieldDefinitionUpdate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> FieldDefinition:
    field = await field_service.update_field(
        session, slug, event_type_id, field_id, data, branch_id
    )
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
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> None:
    fields = await field_service.list_fields(session, slug, event_type_id, branch_id)
    name = next((f.name for f in fields if f.id == field_id), "")
    await field_service.delete_field(session, slug, event_type_id, field_id, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="field.delete",
        target_type="field_definition",
        target_id=field_id,
        target_name=name,
        project_slug=slug,
    )
