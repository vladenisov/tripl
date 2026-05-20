import uuid

from fastapi import APIRouter

from tripl.api.deps import EditorUserDep, SessionDep
from tripl.models.event_type import EventType
from tripl.schemas.event_type import EventTypeCreate, EventTypeResponse, EventTypeUpdate
from tripl.schemas.schema_drift import SchemaDriftListResponse
from tripl.services import audit_service, event_type_service, schema_drift_service

router = APIRouter(prefix="/projects/{slug}/event-types", tags=["event-types"])


@router.get("", response_model=list[EventTypeResponse])
async def list_event_types(session: SessionDep, slug: str) -> list[EventTypeResponse]:
    return await event_type_service.list_event_types(session, slug)


@router.post("", response_model=EventTypeResponse, status_code=201)
async def create_event_type(
    session: SessionDep,
    slug: str,
    data: EventTypeCreate,
    current_user: EditorUserDep,
) -> EventType:
    et = await event_type_service.create_event_type(session, slug, data)
    await audit_service.record(
        session,
        user=current_user,
        action="event_type.create",
        target_type="event_type",
        target_id=et.id,
        target_name=et.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return et


@router.get("/{event_type_id}", response_model=EventTypeResponse)
async def get_event_type(session: SessionDep, slug: str, event_type_id: uuid.UUID) -> EventType:
    return await event_type_service.get_event_type(session, slug, event_type_id)


@router.patch("/{event_type_id}", response_model=EventTypeResponse)
async def update_event_type(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    data: EventTypeUpdate,
    current_user: EditorUserDep,
) -> EventType:
    et = await event_type_service.update_event_type(session, slug, event_type_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="event_type.update",
        target_type="event_type",
        target_id=et.id,
        target_name=et.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return et


@router.delete("/{event_type_id}", status_code=204)
async def delete_event_type(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    existing = await event_type_service.get_event_type(session, slug, event_type_id)
    name = existing.name
    await event_type_service.delete_event_type(session, slug, event_type_id)
    await audit_service.record(
        session,
        user=current_user,
        action="event_type.delete",
        target_type="event_type",
        target_id=event_type_id,
        target_name=name,
        project_slug=slug,
    )


@router.get("/{event_type_id}/drifts", response_model=SchemaDriftListResponse)
async def list_event_type_drifts(
    session: SessionDep, slug: str, event_type_id: uuid.UUID
) -> SchemaDriftListResponse:
    return await schema_drift_service.list_drifts_for_event_type(
        session, slug, event_type_id
    )
