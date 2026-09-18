import uuid
from collections.abc import Mapping

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.fact_table import FactTable
from tripl.models.scan_config import ScanConfig
from tripl.schemas.fact_table import FactTableCreate, FactTableUpdate
from tripl.services.fact_table_dependents import (
    fact_table_conflict_detail,
    metrics_depending_on,
    metrics_needing_filter,
)
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


def _stored_filter_names(fact_table: FactTable) -> list[str]:
    """The named row filters currently stored on the table, in stored order.

    ``row_filters`` is a JSON column, so a legacy row can be any shape; anything
    without a string ``name`` is skipped rather than raising, because a
    referential guard must never turn an unrelated edit into a 500.
    """
    return [
        row["name"]
        for row in (fact_table.row_filters or [])
        if isinstance(row, Mapping) and isinstance(row.get("name"), str)
    ]


async def _reject_updates_that_strand_a_metric(
    session: AsyncSession,
    fact_table: FactTable,
    update_data: dict[str, object],
) -> None:
    """409 when this PATCH would leave a saved fact metric pointing at nothing.

    Two edits are referential, not presentational:

    * dropping or renaming a named row filter — metrics store the NAME, and
      ``_fact_conditions._resolve_named_filter_fragment`` raises at collection
      time when it no longer resolves;
    * unbinding the data source — ``metric_collect`` raises "FactTable ... has no
      data source bound" for every metric on the table.

    ``exclude_unset`` is what makes the row-filter arm safe to write this way: a
    PATCH that does not mention ``row_filters`` has no key here and cannot trip
    the guard, while an explicit ``"row_filters": []`` does, because removing all
    of them is exactly the destructive case. Same for ``data_source_id``: the key
    is present only when the client actually sent it, so ``None`` here always
    means "unbind", never "left alone".

    The dependents query runs only when one of those two keys is present, so an
    ordinary rename of ``display_name`` still costs nothing.
    """
    unbinding = "data_source_id" in update_data and update_data["data_source_id"] is None
    removed_filters: list[str] = []
    if "row_filters" in update_data:
        # ``update_data`` is untyped at this boundary (it arrives from
        # ``model_dump(exclude_unset=True)``), so narrow before iterating: a
        # value that is not a list leaves ``surviving`` empty, which reports
        # every stored filter as removed and makes the guard below refuse the
        # update rather than let a malformed payload strand a metric silently.
        raw_surviving = update_data["row_filters"]
        surviving = {
            row["name"]
            for row in (raw_surviving if isinstance(raw_surviving, list) else [])
            if isinstance(row, Mapping) and isinstance(row.get("name"), str)
        }
        removed_filters = [
            name for name in _stored_filter_names(fact_table) if name not in surviving
        ]
    if not unbinding and not removed_filters:
        return

    dependents = await metrics_depending_on(
        session, project_id=fact_table.project_id, fact_table_id=fact_table.id
    )
    if not dependents:
        return

    for name in removed_filters:
        blocking = metrics_needing_filter(dependents, name)
        if blocking:
            raise HTTPException(
                status_code=409,
                detail=fact_table_conflict_detail(
                    metrics=blocking,
                    lead=f"Cannot remove or rename the row filter {name!r}.",
                    reason="That row filter is used by",
                    then="change the filter",
                ),
            )
    if unbinding:
        raise HTTPException(
            status_code=409,
            detail=fact_table_conflict_detail(
                metrics=dependents,
                lead="Cannot unbind this fact table's data source.",
                reason="This fact table is read by",
                then="unbind it",
            ),
        )


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

    # Before the blind ``setattr`` loop below: the loop has no referential
    # validation of any kind, so anything that could strand a saved metric has to
    # be refused here or not at all.
    await _reject_updates_that_strand_a_metric(session, fact_table, update_data)

    for key, value in update_data.items():
        setattr(fact_table, key, value)
    await session.commit()
    await session.refresh(fact_table)
    await _refresh_main_search_index(session, fact_table.project_id, slug)
    return fact_table


async def delete_fact_table(session: AsyncSession, slug: str, fact_table_id: uuid.UUID) -> None:
    fact_table = await get_fact_table(session, slug, fact_table_id)
    project_id = fact_table.project_id
    # ``metric_definitions.fact_table_id`` is ``ON DELETE SET NULL``, so the
    # database accepts this silently and leaves a fact metric with no table to
    # read — and a ratio operand's id lives in another metric's ``config`` JSON,
    # which no FK reaches at all. Refusing here is the only place the user is
    # still in a position to do something about it.
    dependents = await metrics_depending_on(
        session, project_id=project_id, fact_table_id=fact_table.id
    )
    if dependents:
        raise HTTPException(
            status_code=409,
            detail=fact_table_conflict_detail(
                metrics=dependents,
                lead="Cannot delete this fact table.",
                reason="This fact table is read by",
                then="delete the fact table",
            ),
        )
    await session.delete(fact_table)
    await session.commit()
    await _refresh_main_search_index(session, project_id, slug)
