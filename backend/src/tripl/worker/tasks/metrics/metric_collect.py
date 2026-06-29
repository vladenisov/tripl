"""Celery task that collects per-bucket values for catalog MetricDefinitions.

Mirrors ``collect_metrics`` (event metrics) but writes Float values into
``metric_values`` / ``metric_value_breakdowns`` for one ``MetricDefinition`` per
run. Three kinds are supported:

* ``fact_aggregation`` -- an aggregation over a measure column of a warehouse
  base query, via ``adapter.get_time_bucketed_aggregate`` (+ optional
  per-dimension breakdowns via ``get_time_bucketed_aggregate_breakdown``).
* ``sql`` -- a user-authored per-bucket SELECT, executed via
  ``adapter.get_preview_rows`` after a defensive ``validate_select_sql`` that
  binds the value/time column names.
* ``event_composition`` -- derived from already-collected ``event_metrics`` on
  the source scan grid: ``single`` count, ``ratio`` A/B, or
  ``per_distinct_user`` (numerator / per-bucket distinct-user count, the latter
  being a fresh warehouse ``count_distinct`` series).

Idempotency: every kind WINDOW-DELETEs the affected ``(definition[, config])``
rows before UPSERTing, so a re-run overwrites a window instead of duplicating
it. ``fact_aggregation`` / ``sql`` write ``scan_config_id = NULL`` rows;
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
from datetime import UTC, datetime, timedelta
from typing import cast

from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.core.adapters.base import BaseAdapter
from tripl.core.adapters.measure_validator import (
    coerce_aggregation,
    requires_measure,
    validate_identifier,
    validate_measure_column,
    validate_select_sql,
)
from tripl.core.intervals import get_interval
from tripl.models.data_source import DataSource
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricKind,
    MetricStatus,
)
from tripl.models.event_metric import EventMetric
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

# First-collection lookback for fact_aggregation / sql metrics (in interval
# buckets), mirroring collect_metrics' ``time_to - delta * 30`` default.
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
    """Resolve the [from, to) collection window for a fact_aggregation/sql metric.

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


def _resolve_fact_base_query(config: Mapping[str, object]) -> str:
    """Resolve the effective base query for a fact_aggregation metric.

    Either an explicit ``base_query`` or a ``source_table`` (validated as an
    identifier). A ``filter_sql`` fragment, when present, wraps the source in a
    bounded ``WHERE`` subquery. Both inputs were already validated at the schema
    boundary; the identifier/fragment checks here are defence in depth.
    """
    base_query = _config_str(config, "base_query")
    source_table = _config_str(config, "source_table")
    if base_query is not None:
        source = base_query
    elif source_table is not None:
        source = f"SELECT * FROM {validate_identifier(source_table)}"
    else:
        msg = "fact_aggregation metric requires base_query or source_table in config"
        raise ScanError(msg)

    filter_sql = _config_str(config, "filter_sql")
    if filter_sql is not None:
        return f"SELECT * FROM ({source}) AS _filtered WHERE {filter_sql}"
    return source


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
    """Collect per-dimension breakdown values for a fact_aggregation chunk.

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


def _collect_fact_aggregation(
    session: Session, *, definition: MetricDefinition
) -> dict[str, object]:
    """Collect a fact_aggregation metric: agg(measure) per interval bucket."""
    if definition.data_source_id is None or definition.interval is None:
        msg = "fact_aggregation metric requires a data source and interval"
        raise ScanError(msg)
    if definition.aggregation is None:
        msg = "fact_aggregation metric requires an aggregation"
        raise ScanError(msg)

    config = definition.config or {}
    base_query = _resolve_fact_base_query(config)
    time_column = _config_str(config, "time_column")
    if time_column is None:
        msg = "fact_aggregation metric requires a time_column in config"
        raise ScanError(msg)

    agg = coerce_aggregation(definition.aggregation)
    measure_column = _config_str(config, "measure_column")

    ds = session.get(DataSource, definition.data_source_id)
    if ds is None:
        msg = "DataSource for fact_aggregation metric not found"
        raise ScanError(msg)

    adapter = _build_adapter(ds)
    total_values = 0
    total_breakdowns = 0
    try:
        adapter.test_connection()
        allowed_columns = {c.name for c in adapter.get_columns(base_query)}
        validated_measure: str | None = None
        if requires_measure(agg):
            if measure_column is None:
                msg = f"aggregation {agg.value!r} requires a measure_column in config"
                raise ScanError(msg)
            validated_measure = validate_measure_column(measure_column, allowed_columns)

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
            _cols, _json_value_names, rows = adapter.get_time_bucketed_aggregate(
                base_query,
                time_column,
                interval_spec.ch_interval,
                agg,
                validated_measure,
                [],
                [],
                None,
                chunk_from,
                chunk_to,
                limit=METRIC_QUERY_ROW_LIMIT,
            )
            values = {_coerce_bucket(row[0], delta): _coerce_value(row[-1]) for row in rows}
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
                time_column=time_column,
                ch_interval=interval_spec.ch_interval,
                agg=agg,
                measure_column=validated_measure,
                chunk_from=chunk_from,
                chunk_to=chunk_to,
            )
            session.commit()
    finally:
        adapter.close()

    return {"values": total_values, "breakdown_values": total_breakdowns}


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
    MetricKind.fact_aggregation: _collect_fact_aggregation,
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
        summary = _COLLECTORS[kind](session, definition=definition)

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
