import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.models.event_type import EventType
from tripl.schemas.event_type import EventTypeCreate, EventTypeResponse, EventTypeUpdate
from tripl.services.plan_branch_service import ensure_main_branch_id
from tripl.services.project_service import get_project_id_by_slug


async def list_event_types(session: AsyncSession, slug: str) -> list[EventTypeResponse]:
    cached = await cache.get_json(cache.key_event_types_list(slug))
    if cached is not None:
        return [EventTypeResponse.model_validate(item) for item in cached]

    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    result = await session.execute(
        select(EventType)
        .where(EventType.project_id == project_id, EventType.branch_id == branch_id)
        .order_by(EventType.order, EventType.created_at)
        .limit(1000)  # defensive cap; realistic projects have <100 event types
    )
    rows = list(result.scalars().all())
    responses = [EventTypeResponse.model_validate(et) for et in rows]
    await cache.set_json(
        cache.key_event_types_list(slug),
        [r.model_dump(mode="json") for r in responses],
        ttl_seconds=300,
    )
    return responses


async def get_event_type(session: AsyncSession, slug: str, event_type_id: uuid.UUID) -> EventType:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
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


async def create_event_type(session: AsyncSession, slug: str, data: EventTypeCreate) -> EventType:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
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
    et = EventType(**data.model_dump(), project_id=project_id, branch_id=branch_id)
    session.add(et)
    await session.commit()
    await session.refresh(et)
    await cache.delete_prefix(cache.prefix_event_types(slug))
    # Event types are shown on ProjectsPage summary cards via event counts; bust it.
    await cache.delete_prefix(cache.prefix_projects())
    return et


async def update_event_type(
    session: AsyncSession, slug: str, event_type_id: uuid.UUID, data: EventTypeUpdate
) -> EventType:
    et = await get_event_type(session, slug, event_type_id)
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(et, key, value)
    await session.commit()
    await session.refresh(et)
    await cache.delete_prefix(cache.prefix_event_types(slug))
    return et


async def delete_event_type(session: AsyncSession, slug: str, event_type_id: uuid.UUID) -> None:
    et = await get_event_type(session, slug, event_type_id)
    await session.delete(et)
    await session.commit()
    await cache.delete_prefix(cache.prefix_event_types(slug))
    await cache.delete_prefix(cache.prefix_projects())
