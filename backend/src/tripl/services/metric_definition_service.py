import uuid
from dataclasses import dataclass
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.data_source import DataSource
from tripl.models.domain_enums import MetricKind, MetricScopeType, MetricStatus
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.fact_table import FactTable
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.schemas.event_metric import MetricSignalResponse
from tripl.schemas.metric_definition import (
    EventCompositionMetricCreate,
    FactMetricCreate,
    FactOperand,
    MetricDefinitionBulkUpdate,
    MetricDefinitionCreate,
    MetricDefinitionListItem,
    MetricDefinitionMove,
    MetricDefinitionReorder,
    MetricDefinitionUpdate,
    SqlMetricCreate,
)
from tripl.services.metrics_service import _signal_from_anomaly
from tripl.services.monitoring_utils import classify_signal_state
from tripl.services.project_lookup import get_project_id_by_slug

# Defensive cap on the list query; realistic projects have well under this many
# metric definitions.
_LIST_HARD_CAP = 1000

# Number of trailing values returned per metric for the catalog sparkline.
_SPARK_POINTS = 20


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


async def _verify_fact_operand(
    session: AsyncSession,
    project_id: uuid.UUID,
    *,
    fact_table_id: uuid.UUID,
    measure_column: str | None,
    distinct_column: str | None,
    row_filters: list[str],
    role: str,
) -> None:
    """Validate one fact operand against its referenced fact table.

    The fact table must exist and belong to the metric's project; any
    ``measure_column`` / ``distinct_column`` must be one of the fact table's
    introspected column names; EVERY name in ``row_filters`` must be the NAME of
    one of the fact table's stored row filters (never a raw SQL fragment).
    ``filter_sql`` is a free-text fragment guarded at the schema boundary (same
    trust model as the named fragments), so it needs no DB-backed check here.
    Identifier-shape and per-aggregation requirements were already enforced at
    the schema boundary.
    """
    fact_table = await session.get(FactTable, fact_table_id)
    if fact_table is None or fact_table.project_id != project_id:
        raise HTTPException(
            status_code=422,
            detail=f"{role}: referenced fact table does not exist in the project",
        )

    column_names = {
        column["name"]
        for column in (fact_table.columns or [])
        if isinstance(column, dict) and "name" in column
    }
    for column in (measure_column, distinct_column):
        if column is not None and column not in column_names:
            raise HTTPException(
                status_code=422,
                detail=f"{role}: column {column!r} is not a column of the referenced fact table",
            )

    if row_filters:
        filter_names = {
            row["name"]
            for row in (fact_table.row_filters or [])
            if isinstance(row, dict) and "name" in row
        }
        for name in row_filters:
            if name not in filter_names:
                raise HTTPException(
                    status_code=422,
                    detail=f"{role}: row filter {name!r} is not defined on the referenced "
                    "fact table",
                )


async def _verify_fact_metric(
    session: AsyncSession,
    project_id: uuid.UUID,
    data: FactMetricCreate,
) -> None:
    """Validate a fact metric's operand(s) against their fact table(s)."""
    if data.numerator is not None and data.denominator is not None:
        operands: list[tuple[str, FactOperand]] = [
            ("numerator", data.numerator),
            ("denominator", data.denominator),
        ]
        for role, operand in operands:
            await _verify_fact_operand(
                session,
                project_id,
                fact_table_id=operand.fact_table_id,
                measure_column=operand.measure_column,
                distinct_column=operand.distinct_column,
                row_filters=operand.effective_row_filters(),
                role=role,
            )
        return

    # SINGLE: the schema guarantees fact_table_id is set for a single fact metric.
    if data.fact_table_id is None:
        raise ValueError("single fact metric requires fact_table_id")
    await _verify_fact_operand(
        session,
        project_id,
        fact_table_id=data.fact_table_id,
        measure_column=data.measure_column,
        distinct_column=data.distinct_column,
        row_filters=data.effective_row_filters(),
        role="single",
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


@dataclass(frozen=True)
class _MetricListEnrichment:
    latest_value: float | None
    latest_bucket: datetime | None
    spark: list[float]
    latest_signal: MetricSignalResponse | None


async def _load_latest_values(
    session: AsyncSession,
    metric_ids: list[uuid.UUID],
) -> dict[uuid.UUID, tuple[datetime, float, list[float]]]:
    """One batched, row-bounded query for the latest value + trailing spark.

    A window function (``ROW_NUMBER() OVER (PARTITION BY metric_definition_id
    ORDER BY bucket DESC)``) trims each metric to its trailing ``_SPARK_POINTS``
    rows inside the database, so the transferred result set is bounded at
    ``len(metric_ids) * _SPARK_POINTS`` no matter how much history a metric has
    accumulated — the single-query batch property is kept, but the scan no longer
    grows without limit as data ages. Folds in Python to the latest
    (bucket, value) plus the trailing sparkline, both in ascending bucket order.
    """
    if not metric_ids:
        return {}
    row_number = (
        func.row_number()
        .over(
            partition_by=MetricValue.metric_definition_id,
            order_by=(MetricValue.bucket.desc(), MetricValue.id.desc()),
        )
        .label("rn")
    )
    ranked = (
        select(
            MetricValue.metric_definition_id.label("metric_definition_id"),
            MetricValue.bucket.label("bucket"),
            MetricValue.value.label("value"),
            row_number,
        )
        .where(MetricValue.metric_definition_id.in_(metric_ids))
        .subquery()
    )
    rows = (
        await session.execute(
            select(ranked.c.metric_definition_id, ranked.c.bucket, ranked.c.value)
            .where(ranked.c.rn <= _SPARK_POINTS)
            .order_by(ranked.c.metric_definition_id, ranked.c.bucket)
        )
    ).all()
    series_by_id: dict[uuid.UUID, list[tuple[datetime, float]]] = {}
    for metric_id, bucket, value in rows:
        series_by_id.setdefault(metric_id, []).append((bucket, float(value)))
    result: dict[uuid.UUID, tuple[datetime, float, list[float]]] = {}
    for metric_id, series in series_by_id.items():
        latest_bucket, latest_value = series[-1]
        spark = [value for _bucket, value in series]
        result[metric_id] = (latest_bucket, latest_value, spark)
    return result


async def _load_latest_metric_anomalies(
    session: AsyncSession,
    metric_ids: list[uuid.UUID],
) -> dict[uuid.UUID, MetricAnomaly]:
    """One batched query for the latest anomaly per metric.

    Catalog-metric anomalies live in ``MetricAnomaly`` under
    ``scope_type = 'metric'`` and ``scope_ref = str(metric_definition_id)``
    (the ``MetricScopeType.metric`` scope added by tripl-dxhp.6). Both columns
    are matched so a foreign-scope row reusing the same UUID cannot leak in.
    """
    if not metric_ids:
        return {}
    scope_refs = [str(metric_id) for metric_id in metric_ids]
    by_ref = {str(metric_id): metric_id for metric_id in metric_ids}
    rows = (
        await session.execute(
            select(MetricAnomaly)
            .where(
                MetricAnomaly.scope_type == MetricScopeType.metric.value,
                MetricAnomaly.scope_ref.in_(scope_refs),
            )
            .order_by(MetricAnomaly.bucket)
        )
    ).scalars()
    latest: dict[uuid.UUID, MetricAnomaly] = {}
    for anomaly in rows:
        metric_id = by_ref.get(anomaly.scope_ref)
        if metric_id is not None:
            latest[metric_id] = anomaly  # ascending bucket order → last write wins
    return latest


async def _build_list_enrichment(
    session: AsyncSession,
    metric_ids: list[uuid.UUID],
) -> dict[uuid.UUID, _MetricListEnrichment]:
    latest_values = await _load_latest_values(session, metric_ids)
    latest_anomalies = await _load_latest_metric_anomalies(session, metric_ids)
    enrichment: dict[uuid.UUID, _MetricListEnrichment] = {}
    for metric_id in metric_ids:
        value_row = latest_values.get(metric_id)
        latest_bucket = value_row[0] if value_row else None
        latest_value = value_row[1] if value_row else None
        spark = value_row[2] if value_row else []
        signal: MetricSignalResponse | None = None
        anomaly = latest_anomalies.get(metric_id)
        if anomaly is not None:
            state = classify_signal_state(
                anomaly_bucket=anomaly.bucket,
                latest_metric_bucket=latest_bucket,
            )
            if state is not None:
                signal = _signal_from_anomaly(anomaly, state=state)
        enrichment[metric_id] = _MetricListEnrichment(
            latest_value=latest_value,
            latest_bucket=latest_bucket,
            spark=spark,
            latest_signal=signal,
        )
    return enrichment


async def list_metric_definitions_enriched(
    session: AsyncSession,
    slug: str,
    *,
    status: list[MetricStatus] | None = None,
    kind: MetricKind | None = None,
    search: str | None = None,
    offset: int = 0,
    limit: int = 200,
) -> tuple[list[MetricDefinitionListItem], int]:
    """List rows enriched with per-metric latest value + latest signal + spark.

    Enrichment is two BATCHED queries across all listed ids (one per concern),
    never one-per-metric.
    """
    metrics, total = await list_metric_definitions(
        session,
        slug,
        status=status,
        kind=kind,
        search=search,
        offset=offset,
        limit=limit,
    )
    enrichment = await _build_list_enrichment(session, [metric.id for metric in metrics])
    items: list[MetricDefinitionListItem] = []
    for metric in metrics:
        item = MetricDefinitionListItem.model_validate(metric)
        extra = enrichment.get(metric.id)
        if extra is not None:
            item = item.model_copy(
                update={
                    "latest_value": extra.latest_value,
                    "latest_bucket": extra.latest_bucket,
                    "latest_signal": extra.latest_signal,
                    "spark": extra.spark,
                }
            )
        items.append(item)
    return items, total


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
    if isinstance(data, SqlMetricCreate):
        await _verify_data_source(session, data.data_source_id)
    elif isinstance(data, FactMetricCreate):
        await _verify_fact_metric(session, project_id, data)
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
