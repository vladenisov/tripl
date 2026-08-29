import logging
import uuid
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import Enum
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import delete as sql_delete
from sqlalchemy import func, or_, select, text
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.adapters.measure_validator import SqlDialect, quote_sql_literal
from tripl.core.bucketing import floor_to_bucket, to_utc
from tripl.core.collection_progress import collection_progress_to
from tripl.core.intervals import get_interval
from tripl.metric_grid import metric_grid_stmt, metric_grids
from tripl.metric_monitoring import is_metric_monitored
from tripl.models.data_source import DataSource
from tripl.models.domain_enums import MetricComposition, MetricKind, MetricScopeType, MetricStatus
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.fact_table import FactTable
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.metric_value_breakdown import MetricValueBreakdown
from tripl.schemas.event_metric import MetricSignalResponse
from tripl.schemas.metric_definition import (
    EventCompositionMetricCreate,
    EventCompositionMetricDefinition,
    FactCondition,
    FactMetricCreate,
    FactMetricDefinition,
    FactOperand,
    MetricCollectNowResponse,
    MetricDefinitionBulkUpdate,
    MetricDefinitionConfigUpdate,
    MetricDefinitionCreate,
    MetricDefinitionDetailResponse,
    MetricDefinitionListItem,
    MetricDefinitionMove,
    MetricDefinitionReorder,
    MetricDefinitionUpdate,
    SqlMetricCreate,
    SqlMetricDefinition,
)
from tripl.services._celery_dispatch import dispatch
from tripl.services.metrics_service import (
    _get_project_recent_signal_window,
    _signal_from_anomaly,
)
from tripl.services.monitoring_utils import classify_signal_state, scan_interval_to_timedelta
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_lookup import get_project_id_by_slug
from tripl.services.search_service import reindex_project_branch

logger = logging.getLogger(__name__)

# Defensive cap on the list query; realistic projects have well under this many
# metric definitions.
_LIST_HARD_CAP = 1000

# Ceiling on how many metrics ONE "collect now" click may sweep into its shared
# batch. The fact-table dependency closure is transitive, so without this a click
# on a metric in a long ratio chain can mark most of a project RUNNING and hand a
# single Celery task more work than its soft_time_limit allows. Metrics past the
# cap simply stay on the scheduler.
MAX_MANUAL_COLLECT_GROUP = 25

# Number of trailing values returned per metric for the catalog sparkline.
_SPARK_POINTS = 20

_PATTERN_CONDITION_OPERATORS = frozenset({"contains", "not_contains", "like", "not_like"})
_BOOLEAN_CONDITION_OPERATORS = frozenset(
    {"eq", "ne", "in", "not_in", "is_null", "is_not_null", "is_true", "is_false"}
)


async def _refresh_main_search_index(
    session: AsyncSession, project_id: uuid.UUID, slug: str
) -> None:
    """Refresh the search index after a metric catalog mutation.

    Metrics are global (project-scoped, not branched), so only the MAIN branch
    index is refreshed eagerly; feature-branch indexes pick the change up on
    their next rebuild.
    """
    main_branch_id = await resolve_branch_id(session, project_id, None)
    await reindex_project_branch(
        session, project_id=project_id, branch_id=main_branch_id, slug=slug
    )


async def _verify_data_source(session: AsyncSession, data_source_id: uuid.UUID) -> None:
    exists = await session.scalar(select(DataSource.id).where(DataSource.id == data_source_id))
    if exists is None:
        raise HTTPException(status_code=404, detail="Data source not found")


async def _verify_composition_refs(
    session: AsyncSession,
    project_id: uuid.UUID,
    data: EventCompositionMetricDefinition,
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
    conditions: list[FactCondition],
    role: str,
) -> None:
    """Validate one fact operand against its referenced fact table.

    The fact table must exist and belong to the metric's project; any
    ``measure_column`` / ``distinct_column`` and every structured condition
    column must be one of the fact table's introspected column names; EVERY name
    in ``row_filters`` must be the NAME of one of the fact table's stored row
    filters (never a raw SQL fragment). ``filter_sql`` is a free-text fragment
    guarded at the schema boundary (same trust model as the named fragments), so
    it needs no DB-backed check here.
    Identifier-shape and per-aggregation requirements were already enforced at
    the schema boundary.
    """
    fact_table = await session.get(FactTable, fact_table_id)
    if fact_table is None or fact_table.project_id != project_id:
        raise HTTPException(
            status_code=422,
            detail=f"{role}: referenced fact table does not exist in the project",
        )

    column_types = {
        column["name"]: column["type"]
        for column in (fact_table.columns or [])
        if isinstance(column, dict)
        and isinstance(column.get("name"), str)
        and isinstance(column.get("type"), str)
    }
    column_names = set(column_types)
    for column in (measure_column, distinct_column):
        if column is not None and column not in column_names:
            raise HTTPException(
                status_code=422,
                detail=f"{role}: column {column!r} is not a column of the referenced fact table",
            )
    for condition in conditions:
        if condition.column not in column_names:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{role}: condition column {condition.column!r} is not a column of the "
                    "referenced fact table"
                ),
            )
        _validate_fact_condition_type(
            condition,
            column_type=column_types[condition.column],
            role=role,
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


def _condition_values(condition: FactCondition) -> list[object]:
    """Return the scalar values the worker will compile for one condition.

    ``IN`` / ``NOT IN`` historically accepted either a JSON list or a
    comma-separated string. Preserve that compatibility at save time so the
    service validates the exact values the collector would later compile.
    """
    value = condition.value
    if condition.operator not in {"in", "not_in"}:
        return [] if value is None else [value]
    if isinstance(value, list):
        return list(value)
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    return [] if value is None else [value]


def _is_numeric_condition_value(value: object) -> bool:
    """Match the collector's unquoted numeric-literal contract.

    Native numbers and legacy numeric strings are accepted. Booleans and
    boolean-looking strings are rejected even though all are scalar JSON values:
    a numeric predicate must never silently become ``amount > TRUE``.
    """
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return False
    try:
        literal = quote_sql_literal(value, SqlDialect.clickhouse)
    except ValueError:
        return False
    return not literal.startswith("'") and literal not in {"TRUE", "FALSE"}


def _is_boolean_condition_value(value: object) -> bool:
    if isinstance(value, bool):
        return True
    return isinstance(value, str) and value.strip().lower() in {"true", "false"}


def _validate_fact_condition_type(
    condition: FactCondition,
    *,
    column_type: str,
    role: str,
) -> None:
    """Reject condition/operator mismatches before a metric reaches Celery.

    Fact-table introspection normalises scalar types to ``number``, ``string``,
    ``bool`` and ``timestamp``. Unknown legacy types retain the collector's
    permissive scalar behavior; known types get the same value semantics used by
    the worker plus an operator allowlist that prevents pattern matching numbers
    or truth tests on non-booleans.
    """
    normalized_type = column_type.strip().lower()
    operator = condition.operator
    column = condition.column

    if operator in _PATTERN_CONDITION_OPERATORS and normalized_type in {
        "number",
        "bool",
        "timestamp",
    }:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{role}: operator {operator!r} is not compatible with "
                f"{normalized_type} column {column!r}"
            ),
        )
    if operator in {"is_true", "is_false"} and normalized_type in {
        "number",
        "string",
        "timestamp",
    }:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{role}: operator {operator!r} is only compatible with boolean columns; "
                f"{column!r} is {normalized_type}"
            ),
        )
    if normalized_type == "bool" and operator not in _BOOLEAN_CONDITION_OPERATORS:
        raise HTTPException(
            status_code=422,
            detail=f"{role}: operator {operator!r} is not compatible with bool column {column!r}",
        )
    values = _condition_values(condition)
    if normalized_type == "number" and values:
        if not all(_is_numeric_condition_value(value) for value in values):
            suffix = "values" if operator in {"in", "not_in"} else "value"
            raise HTTPException(
                status_code=422,
                detail=f"{role}: numeric column {column!r} requires numeric {suffix}",
            )
    elif (
        normalized_type == "bool"
        and values
        and not all(_is_boolean_condition_value(value) for value in values)
    ):
        raise HTTPException(
            status_code=422,
            detail=f"{role}: boolean column {column!r} requires true or false",
        )


def _has_metric_breakdowns(
    *,
    breakdown_columns: list[str] | None,
    app_version_column: str | None,
    platform_column: str | None,
) -> bool:
    return bool(breakdown_columns or app_version_column or platform_column)


def _extract_create_breakdown_fields(
    data: FactMetricDefinition,
) -> tuple[list[str], str | None, str | None]:
    """Read shared metric breakdown fields when ``data`` is a create payload."""
    return (
        list(getattr(data, "breakdown_columns", []) or []),
        getattr(data, "app_version_column", None),
        getattr(data, "platform_column", None),
    )


def _reject_cross_table_ratio_breakdowns() -> None:
    raise HTTPException(
        status_code=422,
        detail=(
            "Ratio fact metric breakdowns require numerator and denominator "
            "to use the same fact table"
        ),
    )


def _verify_persisted_ratio_breakdown_compatibility(metric: MetricDefinition) -> None:
    """Guard an already-persisted metric when only dimension fields change."""
    kind = metric.kind if isinstance(metric.kind, MetricKind) else MetricKind(metric.kind)
    if kind is not MetricKind.fact:
        return
    if metric.composition is None:
        return
    composition = (
        metric.composition
        if isinstance(metric.composition, MetricComposition)
        else MetricComposition(metric.composition)
    )
    if composition is not MetricComposition.ratio:
        return
    if not _has_metric_breakdowns(
        breakdown_columns=list(metric.breakdown_columns or []),
        app_version_column=metric.app_version_column,
        platform_column=metric.platform_column,
    ):
        return
    config = metric.config if isinstance(metric.config, Mapping) else {}
    numerator = config.get("numerator")
    denominator = config.get("denominator")
    if not isinstance(numerator, Mapping) or not isinstance(denominator, Mapping):
        return
    numerator_ft_id = numerator.get("fact_table_id")
    denominator_ft_id = denominator.get("fact_table_id")
    if numerator_ft_id is None or denominator_ft_id is None:
        return
    if str(numerator_ft_id) != str(denominator_ft_id):
        _reject_cross_table_ratio_breakdowns()


async def _verify_fact_metric(
    session: AsyncSession,
    project_id: uuid.UUID,
    data: FactMetricDefinition,
    *,
    breakdown_columns: list[str] | None = None,
    app_version_column: str | None = None,
    platform_column: str | None = None,
) -> None:
    """Validate a fact metric's operand(s) against their fact table(s)."""
    if breakdown_columns is None and app_version_column is None and platform_column is None:
        breakdown_columns, app_version_column, platform_column = _extract_create_breakdown_fields(
            data
        )
    if data.numerator is not None and data.denominator is not None:
        if (
            _has_metric_breakdowns(
                breakdown_columns=breakdown_columns,
                app_version_column=app_version_column,
                platform_column=platform_column,
            )
            and data.numerator.fact_table_id != data.denominator.fact_table_id
        ):
            _reject_cross_table_ratio_breakdowns()
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
                conditions=operand.conditions,
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
        conditions=data.conditions,
        role="single",
    )


async def count_active_metric_definitions(
    session: AsyncSession,
    slug: str,
    *,
    kind: MetricKind | None = None,
    search: str | None = None,
) -> int:
    """How many metrics in this project are active, server-side.

    The catalog KPI strip pairs it with the server-side total. "Active" used to
    be counted off the LOADED page, so past the page limit the two stats sat on
    different bases and the strip contradicted itself (tripl-jfm3.109).

    Deliberately ignores the ``status`` filter — the stat answers "how many of my
    metrics are active", which must not change when you filter the list BY
    status — while honouring kind/search so it matches the population on screen.
    """
    project_id = await get_project_id_by_slug(session, slug)
    query = select(func.count(MetricDefinition.id)).where(
        MetricDefinition.project_id == project_id,
        MetricDefinition.status == MetricStatus.active,
    )
    if kind:
        query = query.where(MetricDefinition.kind == kind)
    if search:
        pattern = f"%{search.strip()}%"
        query = query.where(
            or_(
                MetricDefinition.name.ilike(pattern),
                MetricDefinition.display_name.ilike(pattern),
            )
        )
    return int((await session.execute(query)).scalar() or 0)


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
    metrics: list[MetricDefinition],
    *,
    recent_window: timedelta | None = None,
) -> dict[uuid.UUID, _MetricListEnrichment]:
    """Latest value, sparkline and open signal for one page of listed metrics.

    Takes the listed ROWS rather than their ids because the signal half is gated
    on ``status`` and ``anomaly_detection_enabled``, which the caller already
    holds — reading them off the rows keeps the enrichment at its three batched
    queries.
    """
    metric_ids = [metric.id for metric in metrics]
    latest_values = await _load_latest_values(session, metric_ids)
    # "Not monitored" is not monitored on EVERY surface. A metric stops being
    # scored either by its own detection switch or by leaving ``active``
    # (``tripl.metric_monitoring``), and both leave the already-stored rows in
    # place, so a row here reporting an open signal off those leftovers made the
    # metrics list disagree with the Anomalies page and the badge the moment the
    # metric was archived or switched off.
    latest_anomalies = await _load_latest_metric_anomalies(
        session,
        [metric.id for metric in metrics if is_metric_monitored(metric)],
    )
    # Each metric is scored on its OWN grid, so the freshness window has to be
    # measured on that grid too — a daily metric judged against a bare 24h window
    # closes on the day it fires. Resolved HERE rather than handed in by the
    # caller: the caller only holds ``MetricDefinition.interval``, which is NULL
    # for an ``event_composition`` metric whose grid comes from its source scan
    # (tripl-l429.18).
    grids = (
        metric_grids(
            (await session.execute(metric_grid_stmt(MetricDefinition.id.in_(metric_ids)))).all()
        )
        if metric_ids
        else {}
    )
    enrichment: dict[uuid.UUID, _MetricListEnrichment] = {}
    for metric_id in metric_ids:
        value_row = latest_values.get(metric_id)
        latest_bucket = value_row[0] if value_row else None
        latest_value = value_row[1] if value_row else None
        spark = value_row[2] if value_row else []
        signal: MetricSignalResponse | None = None
        anomaly = latest_anomalies.get(metric_id)
        grid = grids.get(metric_id)
        if anomaly is not None:
            state = classify_signal_state(
                anomaly_bucket=anomaly.bucket,
                latest_metric_bucket=latest_bucket,
                interval=scan_interval_to_timedelta(grid.interval if grid is not None else None),
                recent_window=recent_window,
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

    Enrichment is three BATCHED queries across all listed ids (one per concern:
    values, anomalies, grids), never one-per-metric.
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
    # The project's open-signal window is read once per request off any listed row
    # (all listed metrics belong to ``slug``'s project); an empty page classifies
    # nothing, so the lookup is skipped entirely.
    recent_window = (
        await _get_project_recent_signal_window(session, metrics[0].project_id) if metrics else None
    )
    enrichment = await _build_list_enrichment(
        session,
        metrics,
        recent_window=recent_window,
    )
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


def _collection_schedule(
    metric: MetricDefinition,
    latest_bucket: datetime | None,
    *,
    now: datetime,
) -> tuple[datetime | None, bool]:
    """Return ``(next_collection_at, collection_due)`` using scheduler semantics.

    Only active fact/sql metrics with an interval have a predictable schedule.
    With no collected bucket, or with a bucket older than the latest complete
    interval, the metric is due now and ``next_collection_at`` is ``now``. When
    the latest complete bucket is present, the next dispatch becomes due at the
    next interval boundary. Celery beat checks every five minutes, so the value
    is the earliest due boundary rather than a promise of second-exact execution.

    A metric in the error state is held back by the dispatcher's cooldown first,
    whatever its watermark says — see the call below, which asks the scheduler
    rather than reproducing its rule.
    """
    status = (
        metric.status if isinstance(metric.status, MetricStatus) else MetricStatus(metric.status)
    )
    kind = metric.kind if isinstance(metric.kind, MetricKind) else MetricKind(metric.kind)
    if status is not MetricStatus.active or kind not in (MetricKind.fact, MetricKind.sql):
        return None, False
    if metric.interval is None:
        return None, False

    interval_code = str(metric.interval)
    delta = get_interval(interval_code).delta
    moment = to_utc(now)

    # A metric in the error state is not dispatched until its cooldown expires,
    # however far behind its watermark has fallen. Asking the scheduler rather
    # than reproducing its rule: this function used to answer from the watermark
    # alone, so the drilldown said "due now" for a metric the dispatcher would
    # skip for up to a full interval (tripl-os3v). Imported lazily, like the two
    # other scheduler reads in this module, to keep the request path out of the
    # Celery import graph.
    from tripl.worker.tasks.metrics.schedule import metric_definition_cooldown_until

    cooldown_until = metric_definition_cooldown_until(metric, now=moment)
    if cooldown_until is not None:
        return cooldown_until, False

    current_boundary = floor_to_bucket(moment, interval_code)
    progress_to = collection_progress_to(
        last_bucket=latest_bucket,
        watermark=metric.last_collection_window_to,
        delta=delta,
    )
    if progress_to is None or progress_to < current_boundary:
        return moment, True
    return current_boundary + delta, False


async def get_metric_definition_enriched(
    session: AsyncSession, slug: str, metric_id: uuid.UUID
) -> MetricDefinitionDetailResponse:
    """Return a metric detail row with exact next-scheduler metadata."""
    metric = await get_metric_definition(session, slug, metric_id)
    latest_bucket = await session.scalar(
        select(func.max(MetricValue.bucket)).where(
            MetricValue.metric_definition_id == metric.id,
            MetricValue.scan_config_id.is_(None),
        )
    )
    next_collection_at, collection_due = _collection_schedule(
        metric,
        latest_bucket,
        now=datetime.now(UTC),
    )
    return MetricDefinitionDetailResponse.model_validate(metric).model_copy(
        update={
            "next_collection_at": next_collection_at,
            "collection_due": collection_due,
        }
    )


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
    await _refresh_main_search_index(session, project_id, slug)
    return metric


async def _clear_collected_metric_data(session: AsyncSession, metric: MetricDefinition) -> None:
    """Delete the values/breakdowns/anomalies a metric owns, on a KIND change.

    A metric's previously collected series was produced under the OLD kind's
    definition; the new kind computes an incompatible series, so the chart must
    not mix them. This clears every row keyed to this metric:

    * ``MetricValue`` — collected per-bucket values (``metric_definition_id``);
    * ``MetricValueBreakdown`` — per-dimension slices (``metric_definition_id``);
    * ``MetricAnomaly`` — the metric's catalog-scope anomalies
      (``scope_type='metric'``, ``scope_ref=str(metric_id)``; these carry a NULL
      ``scan_config_id`` and are not FK-linked, so they are not CASCADE-deleted).

    Catalog metrics never write ``MetricBreakdownAnomaly`` rows (that table is
    event-scope only and requires a ``scan_config_id``), so there is nothing to
    clear there. The inline collection-status columns are reset so the catalog
    row stops advertising a now-stale last-collected timestamp/state.

    This is called for any material definition change, including same-kind config
    edits; presentation-only updates with an identical definition keep history.
    """
    metric_id = metric.id
    await session.execute(
        sql_delete(MetricValue).where(MetricValue.metric_definition_id == metric_id)
    )
    await session.execute(
        sql_delete(MetricValueBreakdown).where(
            MetricValueBreakdown.metric_definition_id == metric_id
        )
    )
    await session.execute(
        sql_delete(MetricAnomaly).where(
            MetricAnomaly.scope_type == MetricScopeType.metric.value,
            MetricAnomaly.scope_ref == str(metric_id),
        )
    )
    metric.last_collected_at = None
    metric.last_collection_window_to = None
    metric.last_collection_status = None
    metric.last_collection_error = None
    # Cleared with the status it belongs to: a reset that left the failure
    # timestamp behind would leave the metric cooling down from a failure the
    # reset just erased.
    metric.last_collection_failed_at = None


def _normalise_definition_value(value: object) -> object:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {key: _normalise_definition_value(item) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [_normalise_definition_value(item) for item in value]
    return value


def _definition_values_changed(metric: MetricDefinition, new_values: dict[str, object]) -> bool:
    current_values: dict[str, object] = {
        "kind": metric.kind,
        "aggregation": metric.aggregation,
        "composition": metric.composition,
        "config": metric.config or {},
        "fact_table_id": metric.fact_table_id,
        "data_source_id": metric.data_source_id,
        "interval": metric.interval,
        "replay_chunk_interval": metric.replay_chunk_interval,
        "numerator_event_id": metric.numerator_event_id,
        "numerator_event_type_id": metric.numerator_event_type_id,
        "denominator_event_id": metric.denominator_event_id,
        "denominator_event_type_id": metric.denominator_event_type_id,
    }
    return _normalise_definition_value(current_values) != _normalise_definition_value(new_values)


async def _apply_definition_update(
    session: AsyncSession,
    metric: MetricDefinition,
    definition: MetricDefinitionConfigUpdate,
) -> None:
    """Re-validate a kind/config ``definition`` like creation and apply it.

    Runs the SAME DB-backed existence checks creation runs (data source / fact
    table+columns+filters / event refs), then overwrites the metric's identity and
    config columns from ``to_definition_values()``. If the definition changed
    materially, the metric's previously collected data is cleared (see
    :func:`_clear_collected_metric_data`).
    """
    project_id = metric.project_id
    if isinstance(definition, SqlMetricDefinition):
        await _verify_data_source(session, definition.data_source_id)
    elif isinstance(definition, FactMetricDefinition):
        await _verify_fact_metric(
            session,
            project_id,
            definition,
            breakdown_columns=list(metric.breakdown_columns or []),
            app_version_column=metric.app_version_column,
            platform_column=metric.platform_column,
        )
    elif isinstance(definition, EventCompositionMetricDefinition):
        await _verify_composition_refs(session, project_id, definition)

    new_values = definition.to_definition_values()
    changed = _definition_values_changed(metric, new_values)
    for key, value in new_values.items():
        setattr(metric, key, value)
    if changed:
        await _clear_collected_metric_data(session, metric)


async def update_metric_definition(
    session: AsyncSession,
    slug: str,
    metric_id: uuid.UUID,
    data: MetricDefinitionUpdate,
) -> MetricDefinition:
    metric = await get_metric_definition(session, slug, metric_id)
    # Presentation/lifecycle/dimension/monitoring fields: only the ones the client
    # explicitly sent. ``definition`` is applied separately below; ``name`` has no
    # update field and so can never be touched here.
    update_data = data.model_dump(exclude_unset=True, exclude={"definition"})
    for key, value in update_data.items():
        setattr(metric, key, value)
    if data.definition is not None:
        await _apply_definition_update(session, metric, data.definition)
    else:
        _verify_persisted_ratio_breakdown_compatibility(metric)
    await session.commit()
    await session.refresh(metric)
    await _refresh_main_search_index(session, metric.project_id, slug)
    return metric


async def delete_metric_definition(session: AsyncSession, slug: str, metric_id: uuid.UUID) -> None:
    metric = await get_metric_definition(session, slug, metric_id)
    project_id = metric.project_id
    await session.delete(metric)
    await session.commit()
    await _refresh_main_search_index(session, project_id, slug)


async def _dispatch_metric_collection(
    metric_id: uuid.UUID,
    kind: MetricKind,
    window: tuple[datetime, datetime] | None,
    *,
    fact_metric_ids: list[uuid.UUID] | None = None,
) -> str | None:
    """Enqueue the per-kind collection task and return its Celery id (if any).

    Reuses the SAME tasks the scheduler dispatches: ``fact`` metrics through one
    ``collect_fact_metrics_batch`` dependency group, ``sql`` /
    ``event_composition`` through ``collect_metric_definitions``. Imported lazily
    to avoid importing the Celery worker stack at module import time (mirrors
    ``scan_service``). ``force=True`` keeps the clicked draft/archived metric in
    the fact batch; the service only adds active siblings. The fifth task flag
    tells the worker to compute a bounded manual window per interval group.
    """
    # Imported here to avoid circular imports at module level.
    from tripl.worker.tasks.metrics.metric_collect import (
        collect_fact_metrics_batch,
        collect_metric_definitions,
    )

    window_from = window[0].isoformat() if window is not None else None
    window_to = window[1].isoformat() if window is not None else None
    if kind is MetricKind.fact:
        metric_ids = fact_metric_ids or [metric_id]
        async_result = await dispatch(
            collect_fact_metrics_batch.delay,
            [str(item) for item in metric_ids],
            window_from,
            window_to,
            True,
            True,
            str(metric_id),
        )
    else:
        async_result = await dispatch(
            collect_metric_definitions.delay, str(metric_id), window_from, window_to, True
        )
    return getattr(async_result, "id", None)


def _metric_fact_table_ids(metric: MetricDefinition) -> set[uuid.UUID]:
    """Every fact table read by one fact metric, including both ratio operands."""
    kind = metric.kind if isinstance(metric.kind, MetricKind) else MetricKind(metric.kind)
    if kind is not MetricKind.fact:
        return set()

    ids: set[uuid.UUID] = set()
    if metric.fact_table_id is not None:
        ids.add(metric.fact_table_id)
    config = metric.config if isinstance(metric.config, Mapping) else {}
    for role in ("numerator", "denominator"):
        raw = config.get(role)
        if not isinstance(raw, Mapping):
            continue
        raw_id = raw.get("fact_table_id")
        if raw_id is None:
            continue
        try:
            ids.add(uuid.UUID(str(raw_id)))
        except ValueError:
            # Persisted config is defensively parsed by the worker, which will
            # stamp the metric error. Dependency discovery must not turn a valid
            # clicked metric into an API 500 because a sibling row is corrupt.
            continue
    return ids


async def _fact_collection_group(
    session: AsyncSession,
    clicked: MetricDefinition,
) -> list[MetricDefinition]:
    """Clicked metric plus the active fact-metric closure of its fact tables.

    A ratio connects two fact tables. Once such a metric is selected, collecting
    it necessarily refreshes both sources, so every active metric using the newly
    reached table is included too: sharing a scan they would each have run anyway
    is the whole point of the batch.

    That closure is transitive, so chained ratios can walk from one clicked metric
    to most of a project. Expansion is therefore breadth-first from the clicked
    metric's own fact tables and stops at ``MAX_MANUAL_COLLECT_GROUP``, keeping
    the nearest metrics — the ones that actually share the clicked metric's scans.
    Metrics left out are not stranded: they keep their own watermark, so the
    scheduler collects them, and their backlog, on their next tick.
    """
    active = list(
        (
            await session.execute(
                select(MetricDefinition).where(
                    MetricDefinition.project_id == clicked.project_id,
                    MetricDefinition.kind == MetricKind.fact,
                    MetricDefinition.status == MetricStatus.active,
                )
            )
        )
        .scalars()
        .all()
    )
    metrics_by_table: dict[uuid.UUID, list[MetricDefinition]] = {}
    for candidate in active:
        for table_id in _metric_fact_table_ids(candidate):
            metrics_by_table.setdefault(table_id, []).append(candidate)

    selected: dict[uuid.UUID, MetricDefinition] = {clicked.id: clicked}
    # Sorted throughout so an over-large graph truncates the same way every time.
    pending_tables = deque(sorted(_metric_fact_table_ids(clicked), key=str))
    reached_tables = set(pending_tables)
    truncated = False
    while pending_tables and not truncated:
        table_id = pending_tables.popleft()
        candidates = sorted(
            metrics_by_table.get(table_id, []), key=lambda definition: str(definition.id)
        )
        for candidate in candidates:
            if candidate.id in selected:
                continue
            if len(selected) >= MAX_MANUAL_COLLECT_GROUP:
                truncated = True
                break
            selected[candidate.id] = candidate
            for next_table in sorted(_metric_fact_table_ids(candidate), key=str):
                if next_table not in reached_tables:
                    reached_tables.add(next_table)
                    pending_tables.append(next_table)
    if truncated:
        logger.warning(
            "Manual collection of metric %s capped at %d metrics; the rest of its "
            "fact-table dependency graph stays on the scheduler",
            clicked.id,
            MAX_MANUAL_COLLECT_GROUP,
        )
    return sorted(selected.values(), key=lambda definition: str(definition.id))


async def _try_acquire_metric_dispatch_transaction_lock(session: AsyncSession) -> bool:
    """Try to serialize manual dispatch with the catalog scheduler on Postgres.

    The scheduler holds the session-level advisory lock with the same key. A
    transaction-scoped lock participates in the same Postgres advisory-lock
    namespace, but is automatically released by the commit that atomically
    persists every dependency-group member as ``running``. SQLite has no
    advisory locks and remains a no-op for API tests.
    """
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return True

    from tripl.worker.tasks.metrics.schedule import (
        _METRIC_DEFINITION_DISPATCH_ADVISORY_LOCK_KEY,
    )

    acquired = await session.scalar(
        text("SELECT pg_try_advisory_xact_lock(:key)"),
        {"key": _METRIC_DEFINITION_DISPATCH_ADVISORY_LOCK_KEY},
    )
    return bool(acquired)


async def trigger_metric_collection(
    session: AsyncSession, slug: str, metric_id: uuid.UUID
) -> MetricCollectNowResponse:
    """Dispatch an immediate collection backfilling a recent window.

    Used by ``POST /projects/{slug}/metrics/{metric_id}/collect`` so a newly
    created metric shows a chart without waiting for the scheduler. The warehouse
    query runs in the Celery worker, never in this request handler. A fact click
    expands to the active metric closure of every operand fact table, then one
    batch shares compatible source scans; different interval grids receive their
    own bounded manual window. ``event_composition`` has no interval and
    recomputes from the full event-metric series. Collection is idempotent
    (window-delete then upsert), so re-triggering never duplicates rows.
    """
    # Imported here to avoid importing the Celery worker stack at module load.
    from tripl.worker.tasks.metrics.metric_collect import (
        COLLECTION_STATUS_ERROR,
        COLLECTION_STATUS_RUNNING,
        compute_manual_collect_window,
    )
    from tripl.worker.tasks.metrics.schedule import _metric_collection_in_progress

    # This MUST precede every ORM read in the manual dispatch transaction. The
    # scheduler uses the same advisory-lock key, closing the read/check/write
    # race between a manual click and a beat tick.
    if not await _try_acquire_metric_dispatch_transaction_lock(session):
        await session.rollback()
        raise HTTPException(status_code=409, detail="Metric collection dispatcher is busy")
    metric = await get_metric_definition(session, slug, metric_id)
    kind = metric.kind if isinstance(metric.kind, MetricKind) else MetricKind(metric.kind)

    window: tuple[datetime, datetime] | None = None
    if kind in (MetricKind.fact, MetricKind.sql):
        if metric.interval is None:
            raise HTTPException(
                status_code=400,
                detail="Metric has no collection interval to backfill",
            )
        window = compute_manual_collect_window(metric.interval)

    collection_group = (
        await _fact_collection_group(session, metric) if kind is MetricKind.fact else [metric]
    )

    if any(
        _metric_collection_in_progress(definition, now=datetime.now(UTC))
        for definition in collection_group
    ):
        # Release the transaction lock immediately; nothing has been changed.
        await session.rollback()
        raise HTTPException(status_code=409, detail="Metric collection is already running")

    # Mark the whole fact-table dependency group running before dispatch so the
    # scheduler cannot queue one of its active members independently while the
    # shared batch is waiting for a worker.
    for definition in collection_group:
        definition.last_collection_status = COLLECTION_STATUS_RUNNING
        definition.last_collection_error = None
    await session.commit()

    try:
        task_id = await _dispatch_metric_collection(
            metric_id,
            kind,
            window,
            fact_metric_ids=(
                [definition.id for definition in collection_group]
                if kind is MetricKind.fact
                else None
            ),
        )
    except Exception as exc:  # broker unavailable, etc.
        for definition in collection_group:
            definition.last_collection_status = COLLECTION_STATUS_ERROR
            definition.last_collection_error = "Failed to dispatch collection task to worker"
        await session.commit()
        raise HTTPException(
            status_code=503,
            detail="Failed to dispatch collection task to worker",
        ) from exc

    return MetricCollectNowResponse(
        metric_id=metric_id,
        status="queued",
        window_from=window[0] if window is not None else None,
        window_to=window[1] if window is not None else None,
        task_id=task_id,
        metric_count=len(collection_group),
    )


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
    await _refresh_main_search_index(session, project_id, slug)


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
