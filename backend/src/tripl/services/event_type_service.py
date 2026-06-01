import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.schemas.event_type import EventTypeCreate, EventTypeResponse, EventTypeUpdate
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug


async def list_event_types(
    session: AsyncSession, slug: str, branch_id: uuid.UUID | None = None
) -> list[EventTypeResponse]:
    use_cache = branch_id is None
    if use_cache:
        cached = await cache.get_json(cache.key_event_types_list(slug))
        if cached is not None:
            return [EventTypeResponse.model_validate(item) for item in cached]

    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    result = await session.execute(
        select(EventType)
        .where(EventType.project_id == project_id, EventType.branch_id == branch_id)
        .order_by(EventType.order, EventType.created_at)
        .limit(1000)  # defensive cap; realistic projects have <100 event types
    )
    rows = list(result.scalars().all())
    responses = [EventTypeResponse.model_validate(et) for et in rows]
    if use_cache:
        await cache.set_json(
            cache.key_event_types_list(slug),
            [r.model_dump(mode="json") for r in responses],
            ttl_seconds=300,
        )
    return responses


async def get_event_type(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> EventType:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    result = await session.execute(
        select(EventType).where(
            EventType.id == event_type_id,
            EventType.project_id == project_id,
            EventType.branch_id == branch_id,
        )
    )
    et = result.scalar_one_or_none()
    if not et:
        raise HTTPException(status_code=404, detail="Event type not found")
    return et


async def create_event_type(
    session: AsyncSession,
    slug: str,
    data: EventTypeCreate,
    branch_id: uuid.UUID | None = None,
) -> EventType:
    is_main = branch_id is None
    requested_branch_id = branch_id
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    existing = await session.execute(
        select(EventType).where(
            EventType.project_id == project_id,
            EventType.branch_id == branch_id,
            EventType.name == data.name,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409, detail="Event type with this name already exists in project"
        )
    payload = data.model_dump(exclude={"field_definitions"})
    et = EventType(**payload, project_id=project_id, branch_id=branch_id)
    session.add(et)
    await session.flush()
    seen_names: set[str] = set()
    for idx, fd in enumerate(data.field_definitions):
        if fd.name in seen_names:
            raise HTTPException(
                status_code=409, detail=f"Duplicate field name {fd.name!r} in event type"
            )
        seen_names.add(fd.name)
        fd_payload = fd.model_dump()
        fd_payload["order"] = fd.order or idx
        session.add(FieldDefinition(**fd_payload, event_type_id=et.id))
    await session.commit()
    if is_main:
        await cache.delete_prefix(cache.prefix_event_types(slug))
        # Event types feed ProjectsPage summary counts; bust those too.
        await cache.delete_prefix(cache.prefix_projects())
    # Re-fetch so the selectin field_definitions relationship is populated for the response.
    return await get_event_type(session, slug, et.id, requested_branch_id)


async def update_event_type(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    data: EventTypeUpdate,
    branch_id: uuid.UUID | None = None,
) -> EventType:
    is_main = branch_id is None
    et = await get_event_type(session, slug, event_type_id, branch_id)
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(et, key, value)
    await session.commit()
    await session.refresh(et)
    if is_main:
        await cache.delete_prefix(cache.prefix_event_types(slug))
    return et


async def delete_event_type(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> None:
    is_main = branch_id is None
    et = await get_event_type(session, slug, event_type_id, branch_id)
    await session.delete(et)
    await session.commit()
    if is_main:
        await cache.delete_prefix(cache.prefix_event_types(slug))
        await cache.delete_prefix(cache.prefix_projects())
