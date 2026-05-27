import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.schemas.meta_field import MetaFieldCreate, MetaFieldResponse, MetaFieldUpdate
from tripl.services.plan_branch_service import ensure_main_branch_id
from tripl.services.project_service import get_project_id_by_slug


async def list_meta_fields(session: AsyncSession, slug: str) -> list[MetaFieldResponse]:
    cached = await cache.get_json(cache.key_meta_fields_list(slug))
    if cached is not None:
        return [MetaFieldResponse.model_validate(item) for item in cached]

    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    result = await session.execute(
        select(MetaFieldDefinition)
        .where(
            MetaFieldDefinition.project_id == project_id,
            MetaFieldDefinition.branch_id == branch_id,
        )
        .order_by(MetaFieldDefinition.order)
        .limit(1000)  # defensive cap; realistic projects have <50 meta fields
    )
    rows = list(result.scalars().all())
    responses = [MetaFieldResponse.model_validate(mf) for mf in rows]
    await cache.set_json(
        cache.key_meta_fields_list(slug),
        [r.model_dump(mode="json") for r in responses],
        ttl_seconds=300,
    )
    return responses


async def create_meta_field(
    session: AsyncSession, slug: str, data: MetaFieldCreate
) -> MetaFieldDefinition:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    existing = await session.execute(
        select(MetaFieldDefinition).where(
            MetaFieldDefinition.project_id == project_id,
            MetaFieldDefinition.branch_id == branch_id,
            MetaFieldDefinition.name == data.name,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Meta field with this name already exists")
    mf = MetaFieldDefinition(**data.model_dump(), project_id=project_id, branch_id=branch_id)
    session.add(mf)
    await session.commit()
    await session.refresh(mf)
    await cache.delete_prefix(cache.prefix_meta_fields(slug))
    return mf


async def update_meta_field(
    session: AsyncSession, slug: str, meta_field_id: uuid.UUID, data: MetaFieldUpdate
) -> MetaFieldDefinition:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    result = await session.execute(
        select(MetaFieldDefinition).where(
            MetaFieldDefinition.id == meta_field_id,
            MetaFieldDefinition.project_id == project_id,
            MetaFieldDefinition.branch_id == branch_id,
        )
    )
    mf = result.scalar_one_or_none()
    if not mf:
        raise HTTPException(status_code=404, detail="Meta field not found")
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(mf, key, value)
    await session.commit()
    await session.refresh(mf)
    await cache.delete_prefix(cache.prefix_meta_fields(slug))
    return mf


async def delete_meta_field(session: AsyncSession, slug: str, meta_field_id: uuid.UUID) -> None:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    result = await session.execute(
        select(MetaFieldDefinition).where(
            MetaFieldDefinition.id == meta_field_id,
            MetaFieldDefinition.project_id == project_id,
            MetaFieldDefinition.branch_id == branch_id,
        )
    )
    mf = result.scalar_one_or_none()
    if not mf:
        raise HTTPException(status_code=404, detail="Meta field not found")
    await session.delete(mf)
    await session.commit()
    await cache.delete_prefix(cache.prefix_meta_fields(slug))
