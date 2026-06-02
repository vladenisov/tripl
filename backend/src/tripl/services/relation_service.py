import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.event_type_relation import EventTypeRelation
from tripl.schemas.relation import RelationCreate
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug
from tripl.services.search_service import reindex_project_branch


async def list_relations(
    session: AsyncSession, slug: str, branch_id: uuid.UUID | None = None
) -> list[EventTypeRelation]:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    result = await session.execute(
        select(EventTypeRelation).where(
            EventTypeRelation.project_id == project_id,
            EventTypeRelation.branch_id == branch_id,
        )
    )
    return list(result.scalars().all())


async def create_relation(
    session: AsyncSession,
    slug: str,
    data: RelationCreate,
    branch_id: uuid.UUID | None = None,
) -> EventTypeRelation:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    relation = EventTypeRelation(**data.model_dump(), project_id=project_id, branch_id=branch_id)
    session.add(relation)
    await session.commit()
    await session.refresh(relation)
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
    return relation


async def delete_relation(
    session: AsyncSession,
    slug: str,
    relation_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> None:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    result = await session.execute(
        select(EventTypeRelation).where(
            EventTypeRelation.id == relation_id,
            EventTypeRelation.project_id == project_id,
            EventTypeRelation.branch_id == branch_id,
        )
    )
    relation = result.scalar_one_or_none()
    if not relation:
        raise HTTPException(status_code=404, detail="Relation not found")
    await session.delete(relation)
    await session.commit()
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
