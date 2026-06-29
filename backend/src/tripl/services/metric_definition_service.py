import uuid

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.data_source import DataSource
from tripl.models.domain_enums import MetricKind, MetricStatus
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.metric_definition import MetricDefinition
from tripl.schemas.metric_definition import (
    EventCompositionMetricCreate,
    FactAggregationMetricCreate,
    MetricDefinitionBulkUpdate,
    MetricDefinitionCreate,
    MetricDefinitionMove,
    MetricDefinitionReorder,
    MetricDefinitionUpdate,
    SqlMetricCreate,
)
from tripl.services.project_lookup import get_project_id_by_slug

# Defensive cap on the list query; realistic projects have well under this many
# metric definitions.
_LIST_HARD_CAP = 1000


async def _verify_data_source(session: AsyncSession, data_source_id: uuid.UUID) -> None:
    exists = await session.scalar(select(DataSource.id).where(DataSource.id == data_source_id))
    if exists is None:
        raise HTTPException(status_code=404, detail="Data source not found")


async def _verify_composition_refs(
    session: AsyncSession,
    project_id: uuid.UUID,
    data: EventCompositionMetricCreate,
) -> None:
    """Ensure each event/event_type ref resolves to a row in this project.

    Composition metrics read existing event series, so the numerator and
    (for ratios) denominator refs must point at events/event types that
    actually belong to the project.
    """
    event_ids = {
        ref for ref in (data.numerator_event_id, data.denominator_event_id) if ref is not None
    }
    event_type_ids = {
        ref
        for ref in (data.numerator_event_type_id, data.denominator_event_type_id)
        if ref is not None
    }
    if event_ids:
        found = await session.scalar(
            select(func.count(Event.id)).where(
                Event.project_id == project_id, Event.id.in_(event_ids)
            )
        )
        if (found or 0) != len(event_ids):
            raise HTTPException(
                status_code=422, detail="One or more referenced events do not exist in the project"
            )
    if event_type_ids:
        found = await session.scalar(
            select(func.count(EventType.id)).where(
                EventType.project_id == project_id, EventType.id.in_(event_type_ids)
            )
        )
        if (found or 0) != len(event_type_ids):
            raise HTTPException(
                status_code=422,
                detail="One or more referenced event types do not exist in the project",
            )


async def list_metric_definitions(
    session: AsyncSession,
    slug: str,
    *,
    status: list[MetricStatus] | None = None,
    kind: MetricKind | None = None,
    search: str | None = None,
    offset: int = 0,
    limit: int = 200,
) -> tuple[list[MetricDefinition], int]:
    project_id = await get_project_id_by_slug(session, slug)
    query = select(MetricDefinition).where(MetricDefinition.project_id == project_id)
    count_query = select(func.count(MetricDefinition.id)).where(
        MetricDefinition.project_id == project_id
    )

    if status:
        query = query.where(MetricDefinition.status.in_(status))
        count_query = count_query.where(MetricDefinition.status.in_(status))
    if kind:
        query = query.where(MetricDefinition.kind == kind)
        count_query = count_query.where(MetricDefinition.kind == kind)
    if search:
        search_clause = or_(
            MetricDefinition.name.ilike(f"%{search}%"),
            MetricDefinition.display_name.ilike(f"%{search}%"),
            MetricDefinition.description.ilike(f"%{search}%"),
        )
        query = query.where(search_clause)
        count_query = count_query.where(search_clause)

    total = (await session.execute(count_query)).scalar() or 0
    result = await session.execute(
        query.order_by(
            MetricDefinition.order.asc(),
            MetricDefinition.created_at.desc(),
            MetricDefinition.id.asc(),
        )
        .offset(offset)
        .limit(min(limit, _LIST_HARD_CAP))
    )
    return list(result.scalars().all()), int(total)


async def get_metric_definition(
    session: AsyncSession, slug: str, metric_id: uuid.UUID
) -> MetricDefinition:
    project_id = await get_project_id_by_slug(session, slug)
    result = await session.execute(
        select(MetricDefinition).where(
            MetricDefinition.id == metric_id,
            MetricDefinition.project_id == project_id,
        )
    )
    metric = result.scalar_one_or_none()
    if metric is None:
        raise HTTPException(status_code=404, detail="Metric definition not found")
    return metric


async def create_metric_definition(
    session: AsyncSession, slug: str, data: MetricDefinitionCreate
) -> MetricDefinition:
    project_id = await get_project_id_by_slug(session, slug)

    existing = await session.scalar(
        select(MetricDefinition.id).where(
            MetricDefinition.project_id == project_id,
            MetricDefinition.name == data.name,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=409, detail="Metric definition with this name already exists in project"
        )

    # Kind-specific existence checks that the schema cannot do (need the DB).
    if isinstance(data, FactAggregationMetricCreate | SqlMetricCreate):
        await _verify_data_source(session, data.data_source_id)
    elif isinstance(data, EventCompositionMetricCreate):
        await _verify_composition_refs(session, project_id, data)

    metric = MetricDefinition(project_id=project_id, **data.to_create_values())
    session.add(metric)
    await session.flush()
    await session.commit()
    await session.refresh(metric)
    return metric


async def update_metric_definition(
    session: AsyncSession,
    slug: str,
    metric_id: uuid.UUID,
    data: MetricDefinitionUpdate,
) -> MetricDefinition:
    metric = await get_metric_definition(session, slug, metric_id)
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(metric, key, value)
    await session.commit()
    await session.refresh(metric)
    return metric


async def delete_metric_definition(session: AsyncSession, slug: str, metric_id: uuid.UUID) -> None:
    metric = await get_metric_definition(session, slug, metric_id)
    await session.delete(metric)
    await session.commit()


async def bulk_update_metric_definitions(
    session: AsyncSession,
    slug: str,
    data: MetricDefinitionBulkUpdate,
) -> None:
    project_id = await get_project_id_by_slug(session, slug)
    metric_ids = set(data.metric_ids)

    present = await session.scalar(
        select(func.count(MetricDefinition.id)).where(
            MetricDefinition.project_id == project_id,
            MetricDefinition.id.in_(metric_ids),
        )
    )
    if (present or 0) != len(metric_ids):
        raise HTTPException(status_code=404, detail="One or more metric definitions were not found")

    # ``exclude_unset`` keeps explicitly-provided fields only, so an explicit
    # ``owner_id: null`` is included and unassigns the owner; fields the client
    # never sent are left untouched.
    update_values = data.model_dump(exclude={"metric_ids"}, exclude_unset=True)
    await session.execute(
        sql_update(MetricDefinition)
        .where(
            MetricDefinition.project_id == project_id,
            MetricDefinition.id.in_(metric_ids),
        )
        .values(**update_values)
    )
    await session.commit()


async def reorder_metric_definitions(
    session: AsyncSession,
    slug: str,
    data: MetricDefinitionReorder,
) -> list[MetricDefinition]:
    project_id = await get_project_id_by_slug(session, slug)
    result = await session.execute(
        select(MetricDefinition).where(
            MetricDefinition.project_id == project_id,
            MetricDefinition.id.in_(data.metric_ids),
        )
    )
    metrics = list(result.scalars().all())
    if len(metrics) != len(set(data.metric_ids)):
        raise HTTPException(
            status_code=400, detail="Some metric definitions do not belong to this project"
        )

    metrics_by_id = {metric.id: metric for metric in metrics}
    sorted_orders = sorted(metric.order for metric in metrics)
    for new_index, metric_id in enumerate(data.metric_ids):
        metrics_by_id[metric_id].order = sorted_orders[new_index]

    await session.commit()
    refreshed = await session.execute(
        select(MetricDefinition).where(
            MetricDefinition.project_id == project_id,
            MetricDefinition.id.in_(data.metric_ids),
        )
    )
    by_id = {metric.id: metric for metric in refreshed.scalars().all()}
    return [by_id[metric_id] for metric_id in data.metric_ids]


async def move_metric_definition(
    session: AsyncSession,
    slug: str,
    metric_id: uuid.UUID,
    data: MetricDefinitionMove,
) -> MetricDefinition:
    metric = await get_metric_definition(session, slug, metric_id)

    query = select(MetricDefinition).where(MetricDefinition.project_id == metric.project_id)
    if data.visible_metric_ids:
        query = query.where(MetricDefinition.id.in_(data.visible_metric_ids))

    result = await session.execute(
        query.order_by(
            MetricDefinition.order.asc(),
            MetricDefinition.created_at.desc(),
            MetricDefinition.id.asc(),
        )
    )
    ordered = list(result.scalars().all())
    ordered_ids = [item.id for item in ordered]
    if metric.id not in ordered_ids:
        raise HTTPException(status_code=400, detail="Metric is not present in the visible ordering")

    current_index = ordered_ids.index(metric.id)
    target_index = current_index - 1 if data.direction == "up" else current_index + 1
    if target_index < 0 or target_index >= len(ordered):
        return metric

    target = ordered[target_index]
    metric.order, target.order = target.order, metric.order
    await session.commit()
    await session.refresh(metric)
    return metric
