import uuid

from fastapi import APIRouter

from tripl.api.deps import SessionDep
from tripl.models.event_type import EventType
from tripl.schemas.event_type import EventTypeCreate, EventTypeResponse, EventTypeUpdate
from tripl.schemas.schema_drift import SchemaDriftListResponse
from tripl.services import event_type_service, schema_drift_service

router = APIRouter(prefix="/projects/{slug}/event-types", tags=["event-types"])


@router.get("", response_model=list[EventTypeResponse])
async def list_event_types(session: SessionDep, slug: str) -> list[EventTypeResponse]:
    return await event_type_service.list_event_types(session, slug)


@router.post("", response_model=EventTypeResponse, status_code=201)
async def create_event_type(session: SessionDep, slug: str, data: EventTypeCreate) -> EventType:
    return await event_type_service.create_event_type(session, slug, data)


@router.get("/{event_type_id}", response_model=EventTypeResponse)
async def get_event_type(session: SessionDep, slug: str, event_type_id: uuid.UUID) -> EventType:
    return await event_type_service.get_event_type(session, slug, event_type_id)


@router.patch("/{event_type_id}", response_model=EventTypeResponse)
async def update_event_type(
    session: SessionDep, slug: str, event_type_id: uuid.UUID, data: EventTypeUpdate
) -> EventType:
    return await event_type_service.update_event_type(session, slug, event_type_id, data)


@router.delete("/{event_type_id}", status_code=204)
async def delete_event_type(session: SessionDep, slug: str, event_type_id: uuid.UUID) -> None:
    await event_type_service.delete_event_type(session, slug, event_type_id)


@router.get("/{event_type_id}/drifts", response_model=SchemaDriftListResponse)
async def list_event_type_drifts(
    session: SessionDep, slug: str, event_type_id: uuid.UUID
) -> SchemaDriftListResponse:
    return await schema_drift_service.list_drifts_for_event_type(
        session, slug, event_type_id
    )
