"""Celery task that collects per-bucket values for catalog MetricDefinitions.

Mirrors ``collect_metrics`` (event metrics) but writes Float values into
``metric_values`` / ``metric_value_breakdowns`` for one ``MetricDefinition`` per
run. Three kinds are supported:

* ``fact`` -- an aggregation over a column of a separately-defined ``FactTable``,
  via ``adapter.get_time_bucketed_aggregate`` (+ optional per-dimension
  breakdowns via ``get_time_bucketed_aggregate_breakdown``). ``single`` collects
  one operand series; ``ratio`` divides a numerator series by a denominator
  series (each operand a — possibly different — FactTable). The base query, time
  column and data source are taken from the referenced FactTable; a named row
  filter is resolved to its stored SQL fragment at collection time.
* ``sql`` -- a user-authored per-bucket SELECT, executed via
  ``adapter.get_preview_rows`` after a defensive ``validate_select_sql`` that
  binds the value/time column names.
* ``event_composition`` -- derived from already-collected ``event_metrics`` on
  the source scan grid: ``single`` count, ``ratio`` A/B, or
  ``per_distinct_user`` (numerator / per-bucket distinct-user count, the latter
  being a fresh warehouse ``count_distinct`` series).

Idempotency: every kind WINDOW-DELETEs the affected ``(definition[, config])``
rows before UPSERTing, so a re-run overwrites a window instead of duplicating
it. ``fact`` / ``sql`` write ``scan_config_id = NULL`` rows;
``event_composition`` writes rows keyed by the source ``scan_config_id`` grid.

NOTE on divide-by-zero: ``metric_values.value`` is NOT NULL (see the M2 model /
migration), so a ``ratio`` / ``per_distinct_user`` bucket whose denominator is
zero -- which the pure evaluator maps to ``None`` -- is NOT written. The
window-delete-then-insert pass means any previously stored value for that bucket
is cleared, so the bucket reads back as "no value" (absent) rather than a
misleading ``0``.

Tests monkey-patch ``_get_sync_session``, ``_build_adapter`` and
``_resolve_value_window`` as globals of THIS module.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import cast

from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.core.adapters.base import BaseAdapter
from tripl.core.adapters.measure_validator import (
    coerce_aggregation,
    requires_measure,
    validate_measure_column,
    validate_select_sql,
    validate_sql_fragment,
)
from tripl.core.intervals import IntervalSpec, get_interval
from tripl.models.data_source import DataSource
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricKind,
    MetricStatus,
)
from tripl.models.event_metric import EventMetric
from tripl.models.fact_table import FactTable
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.scan_config import ScanConfig
from tripl.worker.analyzers.metric_composition import evaluate_composition
from tripl.worker.celery_app import celery_app
from tripl.worker.tasks._errors import ScanError, user_facing_error
from tripl.worker.tasks.metrics._helpers import (
    _build_adapter,
    _floor_to_interval,
    _get_sync_session,
    _parse_task_datetime,
)
from tripl.worker.tasks.metrics.generation import _iter_window_chunks
from tripl.worker.tasks.metrics.metric_rows import (
    _delete_metric_value_breakdowns_window,
    _delete_metric_values_window,
    _upsert_metric_value_breakdown_rows,
    _upsert_metric_values_rows,
)

logger = logging.getLogger(__name__)

# Persisted ``last_collection_status`` markers (String(32) on MetricDefinition).
COLLECTION_STATUS_RUNNING = "running"
COLLECTION_STATUS_SUCCESS = "success"
COLLECTION_STATUS_ERROR = "error"

# Same per-task budget shape as collect_metrics, scaled down: catalog metrics do
# not run the multi-hour event-catalog replay path.
COLLECT_METRIC_DEFINITIONS_SOFT_TIME_LIMIT_SECONDS = 30 * 60
COLLECT_METRIC_DEFINITIONS_TIME_LIMIT_SECONDS = 35 * 60

# First-collection lookback for fact / sql metrics (in interval buckets),
# mirroring collect_metrics' ``time_to - delta * 30`` default.
DEFAULT_COLLECTION_BUCKETS = 30

# Per-query row ceiling; one row per bucket (no breakdown) or per
# (bucket, breakdown_value), so this comfortably bounds a normal window.
METRIC_QUERY_ROW_LIMIT = 100_000

# Convention for the value column a ``sql`` metric must project (alias the
# measure ``AS value``). The time column name is taken from the metric config.
SQL_VALUE_COLUMN = "value"

# Column used for the per_distinct_user denominator when the metric config does
# not name one. Documented default; override with config ``user_id_column``.
DEFAULT_USER_ID_COLUMN = "user_id"

# Longest breakdown value we persist (matches the breakdown column width).
MAX_BREAKDOWN_VALUE_LENGTH = 500


def _config_str(config: Mapping[str, object], key: str) -> str | None:
    """Return ``config[key]`` only when it is a non-empty string, else ``None``."""
    value = config.get(key)
    return value if isinstance(value, str) and value else None


def _coerce_value(raw: object) -> float:
    """Coerce a warehouse aggregate cell to ``float`` (ints, Decimals, strings)."""
    return float(cast("float | int | str", raw))


def _build_metric_value_rows(
    *,
    metric_definition_id: uuid.UUID,
    scan_config_id: uuid.UUID | None,
    values: Mapping[datetime, float | None],
) -> list[dict[str, object]]:
    """Build MetricValue UPSERT rows, dropping ``None`` (divide-by-zero) buckets.

    The ``value`` column is NOT NULL, so a ``None`` bucket cannot be stored; the
    surrounding window-delete clears any prior value so the bucket reads as
    absent rather than ``0``.
    """
    return [
        {
            "id": uuid.uuid4(),
            "metric_definition_id": metric_definition_id,
            "scan_config_id": scan_config_id,
            "bucket": bucket,
            "value": float(value),
        }
        for bucket, value in values.items()
        if value is not None
    ]


def _resolve_value_window(
    session: Session,
    *,
    metric_definition_id: uuid.UUID,
    delta: timedelta,
) -> tuple[datetime, datetime]:
    """Resolve the [from, to) collection window for a fact/sql metric.

    Window end is the latest complete interval boundary. Window start resumes one
    interval before the last stored bucket (so the last bucket is recomputed), or
    falls back to ``DEFAULT_COLLECTION_BUCKETS`` intervals on first collection.
    Kept here (not in ``_helpers``) so tests can monkey-patch this module global.
    """
    now = datetime.now(UTC)
    time_to = _floor_to_interval(now, delta)
    last_bucket = session.execute(
        select(sa_func.max(MetricValue.bucket)).where(
            MetricValue.metric_definition_id == metric_definition_id,
            MetricValue.scan_config_id.is_(None),
        )
    ).scalar()
    if last_bucket is not None:
        time_from = last_bucket - delta
    else:
        time_from = time_to - delta * DEFAULT_COLLECTION_BUCKETS
    return time_from, time_to


def _read_event_metric_series(
    session: Session,
    *,
    event_id: uuid.UUID | None,
    event_type_id: uuid.UUID | None,
) -> dict[uuid.UUID, dict[datetime, float]]:
    """Load an event-metric count series for one scope, grouped by scan grid.

    Returns ``{scan_config_id: {bucket: count}}``. An ``event_id`` scope reads
    per-event rows; an ``event_type_id`` scope reads per-type rows. Returns an
    empty mapping when neither ref is set.
    """
    if event_id is not None:
        condition = EventMetric.event_id == event_id
    elif event_type_id is not None:
        condition = EventMetric.event_type_id == event_type_id
    else:
        return {}

    series: dict[uuid.UUID, dict[datetime, float]] = {}
    rows = session.execute(
        select(EventMetric.scan_config_id, EventMetric.bucket, EventMetric.count).where(condition)
    ).all()
    for scan_config_id, bucket, count in rows:
        series.setdefault(scan_config_id, {})[bucket] = float(count)
    return series


@dataclass(frozen=True)
class _FactOperand:
    """One resolved fact operand (the single metric, or one ratio side)."""

    fact_table_id: uuid.UUID
    aggregation: MetricAggregation
    measure_column: str | None
    distinct_column: str | None
    row_filter: str | None


def _operand_from_config(raw: Mapping[str, object]) -> _FactOperand:
    """Parse a fact ratio operand from its stored ``config`` dict."""
    fact_table_id = raw.get("fact_table_id")
    aggregation = raw.get("aggregation")
    if not isinstance(fact_table_id, str) or not isinstance(aggregation, str):
        msg = "fact ratio operand requires fact_table_id and aggregation in config"
        raise ScanError(msg)
    return _FactOperand(
        fact_table_id=uuid.UUID(fact_table_id),
        aggregation=coerce_aggregation(aggregation),
        measure_column=_config_str(raw, "measure_column"),
        distinct_column=_config_str(raw, "distinct_column"),
        row_filter=_config_str(raw, "row_filter"),
    )


def _fact_operand_measure(operand: _FactOperand) -> str | None:
    """Effective measure column the adapter aggregates for this operand.

    ``count`` aggregates rows (no column); ``count_distinct`` distinct-counts the
    operand's ``distinct_column``; ``sum``/``avg``/``min``/``max`` aggregate its
    ``measure_column``.
    """
    if operand.aggregation is MetricAggregation.count:
        return None
    if operand.aggregation is MetricAggregation.count_distinct:
        return operand.distinct_column
    return operand.measure_column


def _resolve_fact_operand_query(fact_table: FactTable, row_filter_name: str | None) -> str:
    """Resolve a fact operand's base query, applying its named row filter.

    The base query is the fact table's stored ``sql``. A ``row_filter_name`` (if
    set) must match one of the fact table's stored row filters by NAME; the
    associated (already-validated) fragment wraps the source in a bounded
    ``WHERE`` subquery. The fragment is re-validated here as defence in depth.
    """
    source = fact_table.sql
    if row_filter_name is None:
        return source
    for row_filter in fact_table.row_filters or []:
        if isinstance(row_filter, Mapping) and row_filter.get("name") == row_filter_name:
            fragment = row_filter.get("sql")
            if isinstance(fragment, str) and fragment:
                safe = validate_sql_fragment(fragment)
                return f"SELECT * FROM ({source}) AS _filtered WHERE {safe}"
    msg = f"row filter {row_filter_name!r} is not defined on fact table {fact_table.id}"
    raise ScanError(msg)


def _load_fact_table(
    session: Session, fact_table_id: uuid.UUID | None, *, project_id: uuid.UUID
) -> FactTable:
    """Load a bound FactTable for a fact metric or raise a ``ScanError``.

    The worker has global visibility (no project scope on ``session.get``), so
    the loaded fact table's ``project_id`` is checked against the metric's
    ``project_id`` as defence in depth against a cross-project reference.
    """
    if fact_table_id is None:
        msg = "fact metric requires a fact_table_id"
        raise ScanError(msg)
    fact_table = session.get(FactTable, fact_table_id)
    if fact_table is None:
        msg = f"FactTable {fact_table_id} for fact metric not found"
        raise ScanError(msg)
    if fact_table.project_id != project_id:
        msg = f"FactTable {fact_table_id} does not belong to project {project_id}"
        raise ScanError(msg)
    if fact_table.data_source_id is None:
        msg = f"FactTable {fact_table_id} has no data source bound"
        raise ScanError(msg)
    return fact_table


def _aggregate_fact_window(
    adapter: BaseAdapter,
    *,
    fact_table: FactTable,
    operand: _FactOperand,
    ch_interval: str,
    delta: timedelta,
    chunk_from: datetime,
    chunk_to: datetime,
) -> tuple[dict[datetime, float], str, str | None]:
    """Run one fact operand's bucketed aggregate over a chunk window.

    Returns ``(values_by_bucket, base_query, validated_measure)`` so a SINGLE
    caller can reuse the base query / measure for its breakdown pass.
    """
    base_query = _resolve_fact_operand_query(fact_table, operand.row_filter)
    measure = _fact_operand_measure(operand)
    if requires_measure(operand.aggregation):
        if measure is None:
            msg = (
                f"aggregation {operand.aggregation.value!r} requires a "
                "measure_column / distinct_column"
            )
            raise ScanError(msg)
        columns = adapter.get_columns(base_query)
        if not columns:
            # An empty allowlist would make ``validate_measure_column`` skip its
            # membership check (it short-circuits on a falsy allowlist), silently
            # bypassing the only column guard. Fail loudly instead.
            msg = "fact table query returned no columns; cannot validate measure column"
            raise ScanError(msg)
        allowed_columns = {column.name for column in columns}
        measure = validate_measure_column(measure, allowed_columns)
    _cols, _json_value_names, rows = adapter.get_time_bucketed_aggregate(
        base_query,
        fact_table.timestamp_column,
        ch_interval,
        operand.aggregation,
        measure,
        [],
        [],
        None,
        chunk_from,
        chunk_to,
        limit=METRIC_QUERY_ROW_LIMIT,
    )
    values = {_coerce_bucket(row[0], delta): _coerce_value(row[-1]) for row in rows}
    return values, base_query, measure


def _collect_fact_breakdown_rows(
    session: Session,
    *,
    adapter: BaseAdapter,
    definition: MetricDefinition,
    base_query: str,
    time_column: str,
    ch_interval: str,
    agg: MetricAggregation,
    measure_column: str | None,
    chunk_from: datetime,
    chunk_to: datetime,
) -> int:
    """Collect per-dimension breakdown values for a single fact-metric chunk.

    Each configured breakdown column (plus the optional app-version / platform
    columns) runs one ``get_time_bucketed_aggregate_breakdown`` query. Rows are
    window-deleted then UPSERTed so re-runs do not duplicate. Returns the number
    of breakdown rows written.
    """
    breakdown_columns: list[str] = list(definition.breakdown_columns or [])
    for extra in (definition.app_version_column, definition.platform_column):
        if extra and extra not in breakdown_columns:
            breakdown_columns.append(extra)
    if not breakdown_columns:
        return 0

    rows_out: list[dict[str, object]] = []
    for column in breakdown_columns:
        _cols, _json_value_names, rows = adapter.get_time_bucketed_aggregate_breakdown(
            base_query,
            time_column,
            ch_interval,
            agg,
            measure_column,
            column,
            [column],
            [],
            None,
            chunk_from,
            chunk_to,
            values_limit=definition.breakdown_values_limit,
            limit=METRIC_QUERY_ROW_LIMIT,
        )
        for row in rows:
            rows_out.append(
                {
                    "id": uuid.uuid4(),
                    "metric_definition_id": definition.id,
                    "scan_config_id": None,
                    "bucket": cast(datetime, row[0]),
                    "breakdown_column": column,
                    "breakdown_value": str(row[1])[:MAX_BREAKDOWN_VALUE_LENGTH],
                    "is_other": bool(row[2]),
                    "value": _coerce_value(row[-1]),
                }
            )

    _delete_metric_value_breakdowns_window(
        session,
        metric_definition_id=definition.id,
        time_from=chunk_from,
        time_to=chunk_to,
    )
    _upsert_metric_value_breakdown_rows(session, rows=rows_out)
    return len(rows_out)


def _resolve_fact_composition(definition: MetricDefinition) -> MetricComposition:
    """Coerce a fact metric's composition, defaulting an unset value to single."""
    if definition.composition is None:
        return MetricComposition.single
    if isinstance(definition.composition, MetricComposition):
        return definition.composition
    return MetricComposition(definition.composition)


def _collect_fact(session: Session, *, definition: MetricDefinition) -> dict[str, object]:
    """Collect a ``fact`` metric: an aggregation over a FactTable per bucket.

    SINGLE collects one operand series (+ optional per-dimension breakdowns).
    RATIO divides a numerator series by a denominator series (each over a —
    possibly different — FactTable); a zero/absent denominator maps to ``None``
    (divide-by-zero), which the NOT-NULL row builder drops.
    """
    if definition.interval is None:
        msg = "fact metric requires an interval"
        raise ScanError(msg)
    interval_spec = get_interval(definition.interval)
    delta = interval_spec.delta
    time_from, time_to = _resolve_value_window(
        session, metric_definition_id=definition.id, delta=delta
    )
    composition = _resolve_fact_composition(definition)
    if composition is MetricComposition.ratio:
        return _collect_fact_ratio(
            session,
            definition=definition,
            interval_spec=interval_spec,
            delta=delta,
            time_from=time_from,
            time_to=time_to,
        )
    return _collect_fact_single(
        session,
        definition=definition,
        interval_spec=interval_spec,
        delta=delta,
        time_from=time_from,
        time_to=time_to,
    )


def _collect_fact_single(
    session: Session,
    *,
    definition: MetricDefinition,
    interval_spec: IntervalSpec,
    delta: timedelta,
    time_from: datetime,
    time_to: datetime,
) -> dict[str, object]:
    """Collect a single-operand fact metric (agg(measure) per bucket + breakdowns)."""
    if definition.aggregation is None:
        msg = "single fact metric requires an aggregation"
        raise ScanError(msg)
    config = definition.config or {}
    fact_table = _load_fact_table(
        session, definition.fact_table_id, project_id=definition.project_id
    )
    operand = _FactOperand(
        fact_table_id=fact_table.id,
        aggregation=coerce_aggregation(definition.aggregation),
        measure_column=_config_str(config, "measure_column"),
        distinct_column=_config_str(config, "distinct_column"),
        row_filter=_config_str(config, "row_filter"),
    )
    ds = session.get(DataSource, fact_table.data_source_id)
    if ds is None:
        msg = "DataSource for fact metric not found"
        raise ScanError(msg)
    ch_interval = interval_spec.ch_interval

    adapter = _build_adapter(ds)
    total_values = 0
    total_breakdowns = 0
    try:
        adapter.test_connection()
        chunks = _iter_window_chunks(
            time_from,
            time_to,
            interval_delta=delta,
            chunk_interval_code=definition.replay_chunk_interval,
        )
        for chunk_from, chunk_to in chunks:
            values, base_query, measure = _aggregate_fact_window(
                adapter,
                fact_table=fact_table,
                operand=operand,
                ch_interval=ch_interval,
                delta=delta,
                chunk_from=chunk_from,
                chunk_to=chunk_to,
            )
            value_rows = _build_metric_value_rows(
                metric_definition_id=definition.id,
                scan_config_id=None,
                values=values,
            )
            _delete_metric_values_window(
                session,
                metric_definition_id=definition.id,
                time_from=chunk_from,
                time_to=chunk_to,
            )
            _upsert_metric_values_rows(session, rows=value_rows)
            total_values += len(value_rows)
            total_breakdowns += _collect_fact_breakdown_rows(
                session,
                adapter=adapter,
                definition=definition,
                base_query=base_query,
                time_column=fact_table.timestamp_column,
                ch_interval=ch_interval,
                agg=operand.aggregation,
                measure_column=measure,
                chunk_from=chunk_from,
                chunk_to=chunk_to,
            )
            session.commit()
    finally:
        adapter.close()

    return {"values": total_values, "breakdown_values": total_breakdowns}


def _collect_fact_ratio(
    session: Session,
    *,
    definition: MetricDefinition,
    interval_spec: IntervalSpec,
    delta: timedelta,
    time_from: datetime,
    time_to: datetime,
) -> dict[str, object]:
    """Collect a ratio fact metric: numerator / denominator per bucket.

    Each operand may reference a different FactTable / data source, so a separate
    adapter is built per operand. The two series are divided via
    ``evaluate_composition``; divide-by-zero buckets map to ``None`` and are
    dropped by the NOT-NULL row builder.
    """
    config = definition.config or {}
    numerator_raw = config.get("numerator")
    denominator_raw = config.get("denominator")
    if not isinstance(numerator_raw, Mapping) or not isinstance(denominator_raw, Mapping):
        msg = "ratio fact metric requires numerator and denominator operands in config"
        raise ScanError(msg)
    numerator_op = _operand_from_config(numerator_raw)
    denominator_op = _operand_from_config(denominator_raw)
    numerator_ft = _load_fact_table(
        session, numerator_op.fact_table_id, project_id=definition.project_id
    )
    denominator_ft = _load_fact_table(
        session, denominator_op.fact_table_id, project_id=definition.project_id
    )
    numerator_ds = session.get(DataSource, numerator_ft.data_source_id)
    denominator_ds = session.get(DataSource, denominator_ft.data_source_id)
    if numerator_ds is None or denominator_ds is None:
        msg = "DataSource for fact ratio operand not found"
        raise ScanError(msg)
    ch_interval = interval_spec.ch_interval

    numerator_adapter = _build_adapter(numerator_ds)
    total_values = 0
    try:
        denominator_adapter = _build_adapter(denominator_ds)
        try:
            numerator_adapter.test_connection()
            denominator_adapter.test_connection()
            chunks = _iter_window_chunks(
                time_from,
                time_to,
                interval_delta=delta,
                chunk_interval_code=definition.replay_chunk_interval,
            )
            for chunk_from, chunk_to in chunks:
                numerator_values, _nq, _nm = _aggregate_fact_window(
                    numerator_adapter,
                    fact_table=numerator_ft,
                    operand=numerator_op,
                    ch_interval=ch_interval,
                    delta=delta,
                    chunk_from=chunk_from,
                    chunk_to=chunk_to,
                )
                denominator_values, _dq, _dm = _aggregate_fact_window(
                    denominator_adapter,
                    fact_table=denominator_ft,
                    operand=denominator_op,
                    ch_interval=ch_interval,
                    delta=delta,
                    chunk_from=chunk_from,
                    chunk_to=chunk_to,
                )
                values = evaluate_composition(
                    MetricComposition.ratio,
                    numerator=numerator_values,
                    denominator=denominator_values,
                )
                value_rows = _build_metric_value_rows(
                    metric_definition_id=definition.id,
                    scan_config_id=None,
                    values=values,
                )
                _delete_metric_values_window(
                    session,
                    metric_definition_id=definition.id,
                    time_from=chunk_from,
                    time_to=chunk_to,
                )
                _upsert_metric_values_rows(session, rows=value_rows)
                total_values += len(value_rows)
                session.commit()
        finally:
            denominator_adapter.close()
    finally:
        numerator_adapter.close()

    # Ratio collects no breakdowns; report 0 for shape parity with _collect_fact_single.
    return {"values": total_values, "breakdown_values": 0}


def _collect_sql(session: Session, *, definition: MetricDefinition) -> dict[str, object]:
    """Collect a sql metric: execute the user SELECT and bucket its rows.

    The SELECT must project a ``value`` column and the configured time column
    (re-checked here with ``validate_select_sql``). Each returned row is floored
    to the interval; later rows for the same bucket overwrite earlier ones.
    """
    if definition.data_source_id is None or definition.interval is None:
        msg = "sql metric requires a data source and interval"
        raise ScanError(msg)

    config = definition.config or {}
    metric_sql = _config_str(config, "metric_sql")
    time_column = _config_str(config, "time_column")
    if metric_sql is None or time_column is None:
        msg = "sql metric requires metric_sql and time_column in config"
        raise ScanError(msg)

    safe_sql = validate_select_sql(
        metric_sql, value_column=SQL_VALUE_COLUMN, time_column=time_column
    )

    ds = session.get(DataSource, definition.data_source_id)
    if ds is None:
        msg = "DataSource for sql metric not found"
        raise ScanError(msg)

    adapter = _build_adapter(ds)
    total_values = 0
    try:
        adapter.test_connection()
        interval_spec = get_interval(definition.interval)
        delta = interval_spec.delta
        time_from, time_to = _resolve_value_window(
            session, metric_definition_id=definition.id, delta=delta
        )
        chunks = _iter_window_chunks(
            time_from,
            time_to,
            interval_delta=delta,
            chunk_interval_code=definition.replay_chunk_interval,
        )
        for chunk_from, chunk_to in chunks:
            column_names, rows = adapter.get_preview_rows(
                safe_sql,
                limit=METRIC_QUERY_ROW_LIMIT,
                time_column=time_column,
                time_from=chunk_from,
                time_to=chunk_to,
            )
            index_by_name = {name: i for i, name in enumerate(column_names)}
            if SQL_VALUE_COLUMN not in index_by_name or time_column not in index_by_name:
                msg = f"sql metric must project {SQL_VALUE_COLUMN!r} and {time_column!r} columns"
                raise ScanError(msg)
            value_idx = index_by_name[SQL_VALUE_COLUMN]
            time_idx = index_by_name[time_column]
            values: dict[datetime, float] = {}
            for row in rows:
                bucket = _coerce_bucket(row[time_idx], delta)
                values[bucket] = _coerce_value(row[value_idx])
            value_rows = _build_metric_value_rows(
                metric_definition_id=definition.id,
                scan_config_id=None,
                values=values,
            )
            _delete_metric_values_window(
                session,
                metric_definition_id=definition.id,
                time_from=chunk_from,
                time_to=chunk_to,
            )
            _upsert_metric_values_rows(session, rows=value_rows)
            total_values += len(value_rows)
            session.commit()
    finally:
        adapter.close()

    return {"values": total_values}


def _coerce_bucket(raw: object, delta: timedelta) -> datetime:
    """Coerce a projected time cell to an interval-floored aware datetime."""
    dt = raw if isinstance(raw, datetime) else _parse_task_datetime(str(raw))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return _floor_to_interval(dt, delta)


def _collect_distinct_user_series(
    session: Session,
    *,
    scan_config: ScanConfig,
    user_id_column: str,
    time_from: datetime,
    time_to: datetime,
) -> dict[datetime, float]:
    """Collect a per-bucket ``count_distinct(user_id)`` series from the warehouse.

    The denominator for ``per_distinct_user``: a fresh warehouse query against
    the source scan config's data source / base query, bucketed on the config's
    interval. Builds and closes its own adapter (each grid can have a different
    data source).
    """
    if (
        scan_config.data_source_id is None
        or scan_config.time_column is None
        or scan_config.interval is None
    ):
        return {}
    ds = session.get(DataSource, scan_config.data_source_id)
    if ds is None:
        msg = "DataSource for the composition source scan config not found"
        raise ScanError(msg)

    interval_spec = get_interval(scan_config.interval)
    adapter = _build_adapter(ds)
    try:
        adapter.test_connection()
        _cols, _json_value_names, rows = adapter.get_time_bucketed_aggregate(
            scan_config.base_query,
            scan_config.time_column,
            interval_spec.ch_interval,
            MetricAggregation.count_distinct,
            user_id_column,
            [],
            [],
            None,
            time_from,
            time_to,
            limit=METRIC_QUERY_ROW_LIMIT,
        )
    finally:
        adapter.close()
    return {cast(datetime, row[0]): _coerce_value(row[-1]) for row in rows}


def _collect_event_composition(
    session: Session, *, definition: MetricDefinition
) -> dict[str, object]:
    """Collect an event_composition metric from already-stored event_metrics.

    Reads the numerator (and, for ``ratio``, denominator) event-metric series on
    each source scan grid, evaluates the composition per grid, and writes
    ``MetricValue`` rows keyed by that ``scan_config_id``. ``per_distinct_user``
    additionally fetches a warehouse distinct-user denominator per grid.
    """
    if definition.composition is None:
        msg = "event_composition metric requires a composition"
        raise ScanError(msg)
    composition = (
        definition.composition
        if isinstance(definition.composition, MetricComposition)
        else MetricComposition(definition.composition)
    )

    numerator_by_grid = _read_event_metric_series(
        session,
        event_id=definition.numerator_event_id,
        event_type_id=definition.numerator_event_type_id,
    )
    if not numerator_by_grid:
        return {"values": 0, "grids": 0}

    denominator_by_grid: dict[uuid.UUID, dict[datetime, float]] = {}
    if composition is MetricComposition.ratio:
        denominator_by_grid = _read_event_metric_series(
            session,
            event_id=definition.denominator_event_id,
            event_type_id=definition.denominator_event_type_id,
        )

    config = definition.config or {}
    user_id_column = _config_str(config, "user_id_column") or DEFAULT_USER_ID_COLUMN

    total_values = 0
    grids = 0
    for scan_config_id, numerator in numerator_by_grid.items():
        scan_config = session.get(ScanConfig, scan_config_id)
        if scan_config is None or not scan_config.interval:
            # No interval -> cannot align a delete window for this grid; skip.
            continue
        delta = get_interval(scan_config.interval).delta

        if composition is MetricComposition.single:
            values = evaluate_composition(composition, numerator=numerator)
        elif composition is MetricComposition.ratio:
            values = evaluate_composition(
                composition,
                numerator=numerator,
                denominator=denominator_by_grid.get(scan_config_id, {}),
            )
        else:
            # Bound the warehouse distinct-user query to the numerator range so its
            # densified union with the numerator can never exceed that range.
            distinct = _collect_distinct_user_series(
                session,
                scan_config=scan_config,
                user_id_column=user_id_column,
                time_from=min(numerator),
                time_to=max(numerator) + delta,
            )
            values = evaluate_composition(composition, numerator=numerator, denominator=distinct)

        if not values:
            continue
        # Derive the delete window from the UNION of both series -- i.e. every
        # evaluated bucket, including divide-by-zero buckets mapped to None -- not
        # the numerator alone. A ``ratio`` denominator can carry buckets that
        # precede min(numerator) or follow max(numerator); ``evaluate_composition``
        # densifies value rows onto those buckets, so the window cleared before the
        # UPSERT must cover the full union. A numerator-only window would leave such
        # a row stranded once its denominator later drops to zero (value -> None,
        # no UPSERT row), because no future window-delete would ever reach it.
        window_from = min(values)
        window_to = max(values) + delta

        value_rows = _build_metric_value_rows(
            metric_definition_id=definition.id,
            scan_config_id=scan_config_id,
            values=values,
        )
        _delete_metric_values_window(
            session,
            metric_definition_id=definition.id,
            time_from=window_from,
            time_to=window_to,
            scan_config_id=scan_config_id,
        )
        _upsert_metric_values_rows(session, rows=value_rows)
        total_values += len(value_rows)
        grids += 1

    session.commit()
    return {"values": total_values, "grids": grids}


_COLLECTORS = {
    MetricKind.fact: _collect_fact,
    MetricKind.sql: _collect_sql,
    MetricKind.event_composition: _collect_event_composition,
}


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.metrics.collect_metric_definitions",
    bind=True,
    max_retries=0,
    soft_time_limit=COLLECT_METRIC_DEFINITIONS_SOFT_TIME_LIMIT_SECONDS,
    time_limit=COLLECT_METRIC_DEFINITIONS_TIME_LIMIT_SECONDS,
)
def collect_metric_definitions(self: object, metric_definition_id: str) -> dict[str, object]:
    """Collect one catalog metric's per-bucket values into ``metric_values``.

    Dispatches by ``kind`` and stamps ``last_collected_at`` /
    ``last_collection_status`` / ``last_collection_error`` inline (success or a
    sanitized error). The full exception is logged; only a safe summary is
    persisted.
    """
    session = _get_sync_session()
    definition: MetricDefinition | None = None
    try:
        definition = session.get(MetricDefinition, uuid.UUID(metric_definition_id))
        if definition is None:
            msg = f"MetricDefinition {metric_definition_id} not found"
            raise ValueError(msg)

        if definition.status != MetricStatus.active:
            logger.info(
                "MetricDefinition %s is %s, not active; skipping",
                metric_definition_id,
                definition.status,
            )
            return {"skipped": True, "metric_definition_id": metric_definition_id}

        kind = (
            definition.kind
            if isinstance(definition.kind, MetricKind)
            else MetricKind(definition.kind)
        )
        collector = _COLLECTORS.get(kind)
        if collector is None:
            # Every supported kind is registered above; a missing collector means
            # an unsupported kind was dispatched directly. Fail with a clear
            # message rather than a cryptic KeyError.
            msg = f"Metric collection is not implemented for kind {kind.value!r}"
            raise NotImplementedError(msg)
        summary = collector(session, definition=definition)

        definition.last_collected_at = datetime.now(UTC)
        definition.last_collection_status = COLLECTION_STATUS_SUCCESS
        definition.last_collection_error = None
        session.commit()
        return {"metric_definition_id": metric_definition_id, "kind": kind.value, **summary}

    except Exception as exc:
        logger.exception("Metric collection failed for %s", metric_definition_id)
        if definition is not None:
            try:
                session.rollback()
                definition.last_collection_status = COLLECTION_STATUS_ERROR
                definition.last_collection_error = user_facing_error(exc)
                session.commit()
            except Exception:  # pragma: no cover - best-effort status write
                session.rollback()
        else:
            session.rollback()
        raise
    finally:
        session.close()
