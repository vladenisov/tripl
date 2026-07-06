import uuid

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.fact_table import FactTable
from tripl.models.scan_config import ScanConfig
from tripl.schemas.fact_table import FactTableCreate, FactTableUpdate
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_lookup import get_project_id_by_slug
from tripl.services.search_service import reindex_project_branch

# Defensive cap on the list query; realistic projects have well under this many
# fact tables.
_LIST_HARD_CAP = 1000


async def _refresh_main_search_index(
    session: AsyncSession, project_id: uuid.UUID, slug: str
) -> None:
    """Refresh the search index after a fact-table mutation.

    Fact tables are global (project-scoped, not branched), so only the MAIN
    branch index is refreshed eagerly; feature-branch indexes pick the change
    up on their next rebuild.
    """
    main_branch_id = await resolve_branch_id(session, project_id, None)
    await reindex_project_branch(
        session, project_id=project_id, branch_id=main_branch_id, slug=slug
    )


async def _verify_data_source(
    session: AsyncSession, project_id: uuid.UUID, data_source_id: uuid.UUID
) -> None:
    """Assert the data source is bound to this project before persisting a link.

    A data source is global; it "belongs to" a project only when at least one
    ``ScanConfig`` links the two. Scoping the check to ``project_id`` blocks an
    editor from binding a fact table to another project's warehouse by supplying
    a foreign data source id (multi-tenant isolation). This mirrors the preview
    path's scope check in ``fact_table_introspection_service``.
    """
    in_project = await session.scalar(
        select(ScanConfig.id)
        .where(
            ScanConfig.data_source_id == data_source_id,
            ScanConfig.project_id == project_id,
        )
        .limit(1)
    )
    if in_project is None:
        raise HTTPException(status_code=404, detail="Data source not found")


async def _next_order(session: AsyncSession, project_id: uuid.UUID) -> int:
    """Append-at-end order value: one past the project's current maximum."""
    max_order = await session.scalar(
        select(func.max(FactTable.order)).where(FactTable.project_id == project_id)
    )
    return 0 if max_order is None else int(max_order) + 1


async def list_fact_tables(
    session: AsyncSession,
    slug: str,
    *,
    search: str | None = None,
    offset: int = 0,
    limit: int = 200,
) -> tuple[list[FactTable], int]:
    project_id = await get_project_id_by_slug(session, slug)
    query = select(FactTable).where(FactTable.project_id == project_id)
    count_query = select(func.count(FactTable.id)).where(FactTable.project_id == project_id)

    if search:
        search_clause = or_(
            FactTable.name.ilike(f"%{search}%"),
            FactTable.display_name.ilike(f"%{search}%"),
            FactTable.description.ilike(f"%{search}%"),
        )
        query = query.where(search_clause)
        count_query = count_query.where(search_clause)

    total = (await session.execute(count_query)).scalar() or 0
    result = await session.execute(
        query.order_by(
            FactTable.order.asc(),
            FactTable.created_at.desc(),
            FactTable.id.asc(),
        )
        .offset(offset)
        .limit(min(limit, _LIST_HARD_CAP))
    )
    return list(result.scalars().all()), int(total)


async def get_fact_table(session: AsyncSession, slug: str, fact_table_id: uuid.UUID) -> FactTable:
    project_id = await get_project_id_by_slug(session, slug)
    result = await session.execute(
        select(FactTable).where(
            FactTable.id == fact_table_id,
            FactTable.project_id == project_id,
        )
    )
    fact_table = result.scalar_one_or_none()
    if fact_table is None:
        raise HTTPException(status_code=404, detail="Fact table not found")
    return fact_table


async def create_fact_table(session: AsyncSession, slug: str, data: FactTableCreate) -> FactTable:
    project_id = await get_project_id_by_slug(session, slug)

    existing = await session.scalar(
        select(FactTable.id).where(
            FactTable.project_id == project_id,
            FactTable.name == data.name,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=409, detail="Fact table with this name already exists in project"
        )

    if data.data_source_id is not None:
        await _verify_data_source(session, project_id, data.data_source_id)

    order = await _next_order(session, project_id)
    fact_table = FactTable(project_id=project_id, order=order, **data.to_create_values())
    session.add(fact_table)
    await session.flush()
    await session.commit()
    await session.refresh(fact_table)
    await _refresh_main_search_index(session, project_id, slug)
    return fact_table


async def update_fact_table(
    session: AsyncSession,
    slug: str,
    fact_table_id: uuid.UUID,
    data: FactTableUpdate,
) -> FactTable:
    fact_table = await get_fact_table(session, slug, fact_table_id)
    update_data = data.model_dump(exclude_unset=True)

    new_data_source_id = update_data.get("data_source_id")
    if "data_source_id" in update_data and new_data_source_id is not None:
        await _verify_data_source(session, fact_table.project_id, new_data_source_id)

    for key, value in update_data.items():
        setattr(fact_table, key, value)
    await session.commit()
    await session.refresh(fact_table)
    await _refresh_main_search_index(session, fact_table.project_id, slug)
    return fact_table


async def delete_fact_table(session: AsyncSession, slug: str, fact_table_id: uuid.UUID) -> None:
    fact_table = await get_fact_table(session, slug, fact_table_id)
    project_id = fact_table.project_id
    await session.delete(fact_table)
    await session.commit()
    await _refresh_main_search_index(session, project_id, slug)
