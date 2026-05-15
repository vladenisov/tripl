import uuid

from fastapi import APIRouter, Query

from tripl.api.deps import SessionDep
from tripl.models.event import Event
from tripl.schemas.event import (
    EventBulkDelete,
    EventCreate,
    EventListResponse,
    EventMove,
    EventReorder,
    EventResponse,
    EventUpdate,
)
from tripl.services import event_service

router = APIRouter(prefix="/projects/{slug}/events", tags=["events"])


@router.get("", response_model=EventListResponse)
async def list_events(
    session: SessionDep,
    slug: str,
    event_type_id: uuid.UUID | None = None,
    search: str | None = None,
    implemented: bool | None = None,
    tag: str | None = None,
    reviewed: bool | None = None,
    archived: bool | None = None,
    silent_since_days: int | None = Query(None, ge=0, le=3650),
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=10000),
) -> EventListResponse:
    items, total = await event_service.list_events(
        session,
        slug,
        event_type_id,
        search,
        implemented,
        tag,
        reviewed,
        archived,
        offset,
        limit,
        silent_since_days=silent_since_days,
    )
    return EventListResponse(items=items, total=total)


@router.get("/tags", response_model=list[str])
async def list_tags(session: SessionDep, slug: str) -> list[str]:
    return await event_service.list_tags(session, slug)


@router.post("", response_model=EventResponse, status_code=201)
async def create_event(session: SessionDep, slug: str, data: EventCreate) -> Event:
    return await event_service.create_event(session, slug, data)


@router.post("/bulk", response_model=list[EventResponse], status_code=201)
async def bulk_create_events(
    session: SessionDep, slug: str, data: list[EventCreate]
) -> list[Event]:
    return await event_service.bulk_create_events(session, slug, data)


@router.post("/bulk-delete", status_code=204)
async def bulk_delete_events(session: SessionDep, slug: str, data: EventBulkDelete) -> None:
    await event_service.bulk_delete_events(session, slug, data)


@router.patch("/reorder", response_model=list[EventResponse])
async def reorder_events(session: SessionDep, slug: str, data: EventReorder) -> list[Event]:
    return await event_service.reorder_events(session, slug, data)


@router.get("/{event_id}", response_model=EventResponse)
async def get_event(session: SessionDep, slug: str, event_id: uuid.UUID) -> Event:
    return await event_service.get_event(session, slug, event_id)


@router.patch("/{event_id}", response_model=EventResponse)
async def update_event(
    session: SessionDep, slug: str, event_id: uuid.UUID, data: EventUpdate
) -> Event:
    return await event_service.update_event(session, slug, event_id, data)


@router.patch("/{event_id}/move", response_model=EventResponse)
async def move_event(session: SessionDep, slug: str, event_id: uuid.UUID, data: EventMove) -> Event:
    return await event_service.move_event(session, slug, event_id, data)


@router.delete("/{event_id}", status_code=204)
async def delete_event(session: SessionDep, slug: str, event_id: uuid.UUID) -> None:
    await event_service.delete_event(session, slug, event_id)
