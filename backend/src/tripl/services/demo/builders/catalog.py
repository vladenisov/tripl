"""Metrics-catalog builder: a fact table, four metric definitions, and values.

Definitions are built through the authoritative Pydantic create schemas
(``FactTableCreate``, ``SqlMetricCreate``, ``EventCompositionMetricCreate``,
``FactMetricCreate``) so their validators run (SQL safety, identifier allowlist,
fact-composition rules), then persisted as ORM rows via ``to_create_values()``.
The catalog services are deliberately NOT called — each commits internally, which
would break the seeder's single end-of-function commit.

Pre-collected ``MetricValue`` series make the catalog and drilldowns render with
data (the demo worker never runs). The ``sql`` and two ``fact`` series are NOT
invented: they are derived from the synthetic dataset by running the REAL
``SyntheticAdapter`` (via ``registry.build_adapter`` over the demo's synthetic
DataSource) with each metric's validated config — the same shapes the worker
collectors use — so the seeded values are reproducible from the synthetic rows.
The adapter is pure in-memory (no network/filesystem), so it is safe to call
inside async provisioning. Values are deterministic for a given clock/seed.
"""

from __future__ import annotations

import math
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.adapters.base import AggregateSpec, BaseAdapter
from tripl.core.adapters.registry import build_adapter
from tripl.core.intervals import get_interval
from tripl.models.data_source import DataSource
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricStatus,
    ScanInterval,
)
from tripl.models.fact_table import FactTable
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.schemas.fact_table import (
    FactTableColumnSchema,
    FactTableCreate,
    FactTableRowFilter,
)
from tripl.schemas.metric_definition import (
    EventCompositionMetricCreate,
    FactMetricCreate,
    FactOperand,
    SqlConfig,
    SqlMetricCreate,
)
from tripl.services.demo import noise
from tripl.services.demo.scenario import DemoContext


async def build_catalog(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_fact_table(session, ctx)
    metric_defs = await _build_metric_definitions(session, ctx)
    await _build_metric_values(session, ctx, metric_defs)


async def _build_fact_table(session: AsyncSession, ctx: DemoContext) -> None:
    orders_fact_create = FactTableCreate(
        name="orders",
        display_name="Orders",
        description="One row per store order, used by the revenue fact metrics.",
        color="#0ea5e9",
        data_source_id=ctx.data_source_id,
        sql=("SELECT created_at, amount, currency, user_id, country, status FROM orders"),
        timestamp_column="created_at",
        columns=[
            FactTableColumnSchema(name="created_at", type="timestamp"),
            FactTableColumnSchema(name="amount", type="number"),
            FactTableColumnSchema(name="currency", type="string"),
            FactTableColumnSchema(name="user_id", type="string"),
            FactTableColumnSchema(name="country", type="string"),
            FactTableColumnSchema(name="status", type="string"),
        ],
        identifier_columns=["user_id"],
        row_filters=[FactTableRowFilter(name="completed", sql="status = 'completed'")],
    )
    orders_fact = FactTable(
        project_id=ctx.project_id, order=0, **orders_fact_create.to_create_values()
    )
    session.add(orders_fact)
    await session.flush()
    ctx.fact_table_id = orders_fact.id


async def _build_metric_definitions(
    session: AsyncSession, ctx: DemoContext
) -> dict[str, MetricDefinition]:
    """Four definitions: one sql, one event_composition ratio, two fact (single + ratio)."""
    sql_metric_create = SqlMetricCreate(
        name="active_sessions",
        display_name="Active Sessions",
        description="Distinct sessions seen per day.",
        color="#6366f1",
        order=0,
        unit="sessions",
        status=MetricStatus.active,
        anomaly_detection_enabled=True,
        config=SqlConfig(
            metric_sql=(
                "SELECT toStartOfDay(event_time) AS ts, "
                "count(DISTINCT session_id) AS value FROM events"
            ),
            time_column="ts",
        ),
        data_source_id=ctx.data_source_id,
        interval=ScanInterval.d1,
    )
    conversion_metric_create = EventCompositionMetricCreate(
        name="purchase_conversion",
        display_name="Purchase conversion",
        description="Completed purchases per Home Screen View.",
        color="#22c55e",
        order=1,
        unit="%",
        status=MetricStatus.active,
        anomaly_detection_enabled=True,
        composition=MetricComposition.ratio,
        numerator_event_id=ctx.event_ids["Purchase Completed"],
        denominator_event_id=ctx.event_ids["Home Screen View"],
    )
    revenue_metric_create = FactMetricCreate(
        name="revenue_completed",
        display_name="Revenue (completed)",
        description="Sum of completed-order amounts per day.",
        color="#f59e0b",
        order=2,
        unit="$",
        status=MetricStatus.active,
        anomaly_detection_enabled=True,
        composition=MetricComposition.single,
        interval=ScanInterval.d1,
        fact_table_id=ctx.fact_table_id,
        aggregation=MetricAggregation.sum,
        measure_column="amount",
        row_filters=["completed"],
    )
    aov_metric_create = FactMetricCreate(
        name="average_order_value",
        display_name="Average order value",
        description="Completed-order revenue divided by completed-order count.",
        color="#a855f7",
        order=3,
        unit="$",
        status=MetricStatus.active,
        anomaly_detection_enabled=True,
        composition=MetricComposition.ratio,
        interval=ScanInterval.d1,
        numerator=FactOperand(
            fact_table_id=ctx.fact_table_id,
            aggregation=MetricAggregation.sum,
            measure_column="amount",
        ),
        denominator=FactOperand(
            fact_table_id=ctx.fact_table_id,
            aggregation=MetricAggregation.count,
        ),
    )

    metric_defs: dict[str, MetricDefinition] = {}
    for metric_create in (
        sql_metric_create,
        conversion_metric_create,
        revenue_metric_create,
        aov_metric_create,
    ):
        metric_def = MetricDefinition(project_id=ctx.project_id, **metric_create.to_create_values())
        metric_def.last_collected_at = ctx.now
        metric_def.last_collection_status = "success"
        session.add(metric_def)
        metric_defs[metric_create.name] = metric_def
    await session.flush()
    return metric_defs


# 30-day DAILY window for the sql + fact metrics, matching the daily interval
# (``ScanInterval.d1``) the definitions carry.
_DEMO_METRIC_HISTORY_DAYS = 30
# The orders fact-table SQL (kept in sync with ``_build_fact_table``); the
# adapter reads the ``orders`` table from it and applies the operand filters.
_ORDERS_SQL = "SELECT created_at, amount, currency, user_id, country, status FROM orders"
# Per-query row ceiling for the derivation reads (one row per day here).
_METRIC_QUERY_ROW_LIMIT = 100_000


async def _build_metric_values(
    session: AsyncSession, ctx: DemoContext, metric_defs: dict[str, MetricDefinition]
) -> None:
    """Seed each metric's per-bucket values.

    ``purchase_conversion`` (event_composition) is a small live-looking fraction.
    The ``sql`` and two ``fact`` metrics are derived FROM the synthetic dataset by
    running the real ``SyntheticAdapter`` with each metric's config, so the seeded
    values are reproducible from the synthetic rows rather than invented.
    """
    _build_conversion_values(session, ctx, metric_defs["purchase_conversion"])

    data_source = await session.get(DataSource, ctx.data_source_id)
    if data_source is not None:
        adapter = build_adapter(data_source)
        try:
            _build_adapter_derived_values(session, ctx, metric_defs, adapter)
        finally:
            adapter.close()
    await session.flush()


def _build_conversion_values(
    session: AsyncSession, ctx: DemoContext, conversion_metric: MetricDefinition
) -> None:
    # event_composition ratio -> ~7 days HOURLY, aligned to the source scan grid
    # (scan_config_id set). Conversion drifts gently upward with a daily ripple so
    # the ratio reads as a live line; stays a small fraction (~0.05-0.11).
    conversion_buckets = noise.hour_buckets(ctx.now, days=7)
    conversion_span = max(len(conversion_buckets) - 1, 1)
    for idx, bucket in enumerate(conversion_buckets):
        progress = idx / conversion_span
        daily_ripple = 0.015 * math.sin(bucket.hour * math.pi / 12)
        session.add(
            MetricValue(
                metric_definition_id=conversion_metric.id,
                scan_config_id=ctx.scan_config_id,
                bucket=bucket,
                value=0.05 + 0.045 * progress + daily_ripple,
            )
        )


def _build_adapter_derived_values(
    session: AsyncSession,
    ctx: DemoContext,
    metric_defs: dict[str, MetricDefinition],
    adapter: BaseAdapter,
) -> None:
    """Derive the sql + fact series from the synthetic adapter (scan_config_id NULL).

    Mirrors what the worker collectors compute: a conditional daily SUM for the
    filtered single (revenue), a two-operand daily ratio (average order value),
    and the seeded distinct-sessions SQL read back through ``get_preview_rows``.
    """
    day = timedelta(days=1)
    ch_interval = get_interval(ScanInterval.d1.value).ch_interval
    end_day = ctx.now.replace(hour=0, minute=0, second=0, microsecond=0)
    time_from = end_day - day * _DEMO_METRIC_HISTORY_DAYS
    time_to = end_day + day

    # revenue_completed: SUM(amount) WHERE status = 'completed' per day -- the same
    # conditional aggregate the batched fact collector runs for a filtered single.
    revenue_specs = [
        AggregateSpec(
            key="revenue",
            aggregation=MetricAggregation.sum,
            column="amount",
            filter_sql="status = 'completed'",
        )
    ]
    _revenue_cols, revenue_rows = adapter.get_time_bucketed_multi_aggregate(
        _ORDERS_SQL, "created_at", ch_interval, revenue_specs, time_from, time_to
    )
    for bucket, revenue in revenue_rows:
        if revenue is None:
            continue
        session.add(
            MetricValue(
                metric_definition_id=metric_defs["revenue_completed"].id,
                scan_config_id=None,
                bucket=bucket,
                value=float(revenue),  # type: ignore[arg-type]
            )
        )

    # average_order_value: SUM(amount) / COUNT(*) per day -- the ratio's two
    # operands read from one shared daily scan, divided per bucket.
    aov_specs = [
        AggregateSpec(key="numerator", aggregation=MetricAggregation.sum, column="amount"),
        AggregateSpec(key="denominator", aggregation=MetricAggregation.count),
    ]
    _aov_cols, aov_rows = adapter.get_time_bucketed_multi_aggregate(
        _ORDERS_SQL, "created_at", ch_interval, aov_specs, time_from, time_to
    )
    for bucket, numerator, denominator in aov_rows:
        if not denominator:
            continue
        session.add(
            MetricValue(
                metric_definition_id=metric_defs["average_order_value"].id,
                scan_config_id=None,
                bucket=bucket,
                value=float(numerator) / float(denominator),  # type: ignore[arg-type]
            )
        )

    # active_sessions (sql): distinct sessions per day, read back through the same
    # get_preview_rows path the sql collector uses (the adapter recognises the
    # seeded metric SQL and computes it from the synthetic events).
    sql_metric = metric_defs["active_sessions"]
    metric_sql = str((sql_metric.config or {}).get("metric_sql", ""))
    column_names, rows = adapter.get_preview_rows(
        metric_sql,
        limit=_METRIC_QUERY_ROW_LIMIT,
        time_column="ts",
        time_from=time_from,
        time_to=time_to,
    )
    ts_index = column_names.index("ts")
    value_index = column_names.index("value")
    for row in rows:
        session.add(
            MetricValue(
                metric_definition_id=sql_metric.id,
                scan_config_id=None,
                bucket=row[ts_index],
                value=float(row[value_index]),  # type: ignore[arg-type]
            )
        )
