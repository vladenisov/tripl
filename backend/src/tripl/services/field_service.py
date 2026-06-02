import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.models.field_definition import FieldDefinition
from tripl.schemas.field_definition import (
    FieldDefinitionBulkCreate,
    FieldDefinitionCreate,
    FieldDefinitionUpdate,
    FieldReorder,
)
from tripl.services.event_type_service import get_event_type
from tripl.services.search_service import reindex_project_branch


async def list_fields(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> list[FieldDefinition]:
    et = await get_event_type(session, slug, event_type_id, branch_id)
    result = await session.execute(
        select(FieldDefinition)
        .where(FieldDefinition.event_type_id == et.id)
        .order_by(FieldDefinition.order)
    )
    return list(result.scalars().all())


async def create_field(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    data: FieldDefinitionCreate,
    branch_id: uuid.UUID | None = None,
) -> FieldDefinition:
    is_main = branch_id is None
    et = await get_event_type(session, slug, event_type_id, branch_id)
    existing = await session.execute(
        select(FieldDefinition).where(
            FieldDefinition.event_type_id == et.id, FieldDefinition.name == data.name
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409, detail="Field with this name already exists for event type"
        )
    field = FieldDefinition(**data.model_dump(), event_type_id=et.id)
    session.add(field)
    await session.commit()
    await session.refresh(field)
    await reindex_project_branch(
        session,
        project_id=et.project_id,
        branch_id=et.branch_id,
        slug=slug,
    )
    if is_main:
        await cache.delete_prefix(cache.prefix_event_types(slug))
    return field


async def bulk_create_fields(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    data: FieldDefinitionBulkCreate,
    branch_id: uuid.UUID | None = None,
) -> list[FieldDefinition]:
    """Create the supplied fields on an event type, skipping names that already
    exist. Idempotent so it can back a "create missing fields" action."""
    is_main = branch_id is None
    et = await get_event_type(session, slug, event_type_id, branch_id)
    existing = await session.execute(
        select(FieldDefinition).where(FieldDefinition.event_type_id == et.id)
    )
    existing_fields = list(existing.scalars().all())
    existing_names = {f.name for f in existing_fields}
    next_order = max((f.order for f in existing_fields), default=-1) + 1
    created = False
    seen: set[str] = set()
    for field_in in data.fields:
        if field_in.name in existing_names or field_in.name in seen:
            continue
        seen.add(field_in.name)
        payload = field_in.model_dump()
        payload["order"] = next_order
        next_order += 1
        session.add(FieldDefinition(**payload, event_type_id=et.id))
        created = True
    if created:
        await session.commit()
        await reindex_project_branch(
            session,
            project_id=et.project_id,
            branch_id=et.branch_id,
            slug=slug,
        )
        if is_main:
            await cache.delete_prefix(cache.prefix_event_types(slug))
    return await list_fields(session, slug, event_type_id, branch_id)


async def update_field(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    field_id: uuid.UUID,
    data: FieldDefinitionUpdate,
    branch_id: uuid.UUID | None = None,
) -> FieldDefinition:
    is_main = branch_id is None
    et = await get_event_type(session, slug, event_type_id, branch_id)
    result = await session.execute(
        select(FieldDefinition).where(
            FieldDefinition.id == field_id, FieldDefinition.event_type_id == event_type_id
        )
    )
    field = result.scalar_one_or_none()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(field, key, value)
    await session.commit()
    await session.refresh(field)
    await reindex_project_branch(
        session,
        project_id=et.project_id,
        branch_id=et.branch_id,
        slug=slug,
    )
    if is_main:
        await cache.delete_prefix(cache.prefix_event_types(slug))
    return field


async def delete_field(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    field_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> None:
    is_main = branch_id is None
    et = await get_event_type(session, slug, event_type_id, branch_id)
    result = await session.execute(
        select(FieldDefinition).where(
            FieldDefinition.id == field_id, FieldDefinition.event_type_id == event_type_id
        )
    )
    field = result.scalar_one_or_none()
    if not field:
        raise HTTPException(status_code=404, detail="Field not found")
    await session.delete(field)
    await session.commit()
    await reindex_project_branch(
        session,
        project_id=et.project_id,
        branch_id=et.branch_id,
        slug=slug,
    )
    if is_main:
        await cache.delete_prefix(cache.prefix_event_types(slug))


async def reorder_fields(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
    data: FieldReorder,
    branch_id: uuid.UUID | None = None,
) -> list[FieldDefinition]:
    is_main = branch_id is None
    await get_event_type(session, slug, event_type_id, branch_id)
    for idx, field_id in enumerate(data.field_ids):
        result = await session.execute(
            select(FieldDefinition).where(
                FieldDefinition.id == field_id, FieldDefinition.event_type_id == event_type_id
            )
        )
        field = result.scalar_one_or_none()
        if field:
            field.order = idx
    await session.commit()
    if is_main:
        await cache.delete_prefix(cache.prefix_event_types(slug))
    return await list_fields(session, slug, event_type_id, branch_id)
