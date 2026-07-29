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
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TypeGuard, cast

from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.core.adapters.base import AggregateSpec, BaseAdapter
from tripl.core.adapters.measure_validator import (
    SqlDialect,
    coerce_aggregation,
    dialect_for_db_type,
    parse_utc_timestamp,
    quote_identifier,
    quote_sql_literal,
    quote_sql_string_literal,
    quote_timestamp_literal,
    requires_measure,
    time_kind_of,
    validate_identifier,
    validate_measure_column,
    validate_select_sql,
    validate_sql_fragment,
)
from tripl.core.bucketing import floor_to_bucket, to_utc
from tripl.core.collection_progress import collection_progress_to
from tripl.core.intervals import IntervalSpec, get_interval
from tripl.core.warehouse_types import TimeKind
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

# Manual "collect now" backfill: reach back this many interval buckets so a
# freshly-created metric's chart is not empty, regardless of prior collection
# state. Capped by ``MANUAL_COLLECT_MAX_WINDOW`` so a coarse interval (1d/1w)
# does not reach back months/years.
MANUAL_COLLECT_BACKFILL_BUCKETS = 48
MANUAL_COLLECT_MAX_WINDOW = timedelta(days=30)

# Per-query row ceiling; one row per bucket (no breakdown) or per
# (bucket, breakdown_value), so this comfortably bounds a normal window.
METRIC_QUERY_ROW_LIMIT = 100_000

# Default value column a ``sql`` metric must project (alias the measure
# ``AS value``); override per metric with config ``value_column``. The time
# column name is taken from the metric config.
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


def _config_str_list(config: Mapping[str, object], key: str) -> list[str]:
    """Return ``config[key]`` as a list of non-empty strings (else ``[]``)."""
    value = config.get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _effective_filter_names(config: Mapping[str, object]) -> tuple[str, ...]:
    """Effective named-filter set from a stored operand ``config``.

    Reads the new ``row_filters`` list and folds in a legacy single
    ``row_filter`` name (back-compat with configs written before multi-filter
    support). Order is preserved and duplicates removed so the WHERE assembled
    from it is deterministic and identical across the per-metric and batched
    collection paths.
    """
    effective: list[str] = list(_config_str_list(config, "row_filters"))
    legacy = _config_str(config, "row_filter")
    if legacy is not None and legacy not in effective:
        effective.append(legacy)
    return tuple(effective)


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
    interval_code: str,
) -> tuple[datetime, datetime]:
    """Resolve the [from, to) collection window for a fact/sql metric.

    Window end is the latest complete interval boundary. Window start resumes one
    interval before the last stored bucket (so the last bucket is recomputed), or
    falls back to ``DEFAULT_COLLECTION_BUCKETS`` intervals on first collection.
    Kept here (not in ``_helpers``) so tests can monkey-patch this module global.
    """
    delta = get_interval(interval_code).delta
    time_to = floor_to_bucket(datetime.now(UTC), interval_code)
    last_bucket = session.execute(
        select(sa_func.max(MetricValue.bucket)).where(
            MetricValue.metric_definition_id == metric_definition_id,
            MetricValue.scan_config_id.is_(None),
        )
    ).scalar()
    definition = session.get(MetricDefinition, metric_definition_id)
    progress_to = collection_progress_to(
        last_bucket=last_bucket,
        watermark=definition.last_collection_window_to if definition is not None else None,
        delta=delta,
    )
    if progress_to is not None:
        # Preserve the historical two-bucket overlap: the latest completed
        # bucket and the one immediately before it are recomputed for late data.
        effective_progress_to = min(progress_to, time_to)
        time_from = effective_progress_to - delta * 2
    else:
        time_from = time_to - delta * DEFAULT_COLLECTION_BUCKETS
    return time_from, time_to


def compute_manual_collect_window(interval_code: str) -> tuple[datetime, datetime]:
    """Resolve the [from, to) backfill window for a manual single-metric collect.

    ``to`` is the latest complete interval boundary; ``from`` reaches back
    ``MANUAL_COLLECT_BACKFILL_BUCKETS`` buckets, but the span is capped to
    ``MANUAL_COLLECT_MAX_WINDOW`` so coarse intervals stay bounded. Concretely:
    15m -> 48 buckets (12h), 1h -> 48 (2d), 6h -> 48 (12d), 1d -> 30 (30d),
    1w -> 4 (28d). Unlike ``_resolve_value_window`` this ignores any previously
    stored bucket so a re-trigger always backfills the same recent window.
    """
    delta = get_interval(interval_code).delta
    time_to = floor_to_bucket(datetime.now(UTC), interval_code)
    max_buckets = max(1, int(MANUAL_COLLECT_MAX_WINDOW / delta))
    buckets = min(MANUAL_COLLECT_BACKFILL_BUCKETS, max_buckets)
    time_from = time_to - delta * buckets
    return time_from, time_to


def _effective_value_window(
    session: Session,
    *,
    metric_definition_id: uuid.UUID,
    interval_code: str,
    window_override: tuple[datetime, datetime] | None,
    manual_backfill: bool = False,
) -> tuple[datetime, datetime]:
    """Use an explicit ``window_override`` when given, else the resume window.

    Keeps the override-vs-default choice in one place so every fact/sql
    collection path honours a manually-requested window identically.

    ``manual_backfill`` marks the bounded window a "collect now" click derives
    from ``compute_manual_collect_window``. That window is applied to every
    metric the click sweeps in — the whole fact-table dependency closure, not
    just the clicked one — so it may only ever reach FURTHER BACK than a metric's
    own resume point, never ahead of it. A metric lagging by more than the manual
    window (it had been failing, or was just reactivated) would otherwise collect
    only the recent slice while ``_stamp_metric_success`` advanced its watermark
    to the window end, stranding the un-queried buckets in between where no later
    resume reaches them. A legacy explicit replay window (``window_from`` /
    ``window_to`` on the task) is a deliberate request for one exact range and is
    still honoured verbatim.
    """
    if window_override is None:
        return _resolve_value_window(
            session,
            metric_definition_id=metric_definition_id,
            interval_code=interval_code,
        )
    if not manual_backfill:
        return window_override
    resume_from, _ = _resolve_value_window(
        session,
        metric_definition_id=metric_definition_id,
        interval_code=interval_code,
    )
    manual_from, manual_to = window_override
    return min(manual_from, resume_from), manual_to


def _parse_window_override(
    window_from: str | None, window_to: str | None
) -> tuple[datetime, datetime] | None:
    """Parse the optional manual-collection window passed to the Celery tasks.

    Both bounds are required together (mirrors ``collect_metrics`` replay). ISO
    strings are coerced to aware datetimes; ``None``/``None`` means "no override"
    (the scheduler's resume window is used).
    """
    if (window_from is None) != (window_to is None):
        msg = "Both window_from and window_to are required for a manual collection window"
        raise ValueError(msg)
    if window_from is None or window_to is None:
        return None
    time_from = _parse_task_datetime(window_from)
    time_to = _parse_task_datetime(window_to)
    if time_from >= time_to:
        msg = "window_from must be earlier than window_to"
        raise ValueError(msg)
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
class _FactCondition:
    """One stored visual condition row after defensive config parsing."""

    column: str
    operator: str
    value: object | None


type _SqlLiteralValue = str | int | float | bool
_CONDITION_VALUELESS_OPERATORS = frozenset({"is_null", "is_not_null", "is_true", "is_false"})
_CONDITION_MULTI_VALUE_OPERATORS = frozenset({"in", "not_in"})
_CONDITION_BINARY_OPERATORS = {
    "eq": "=",
    "ne": "!=",
    "gt": ">",
    "gte": ">=",
    "lt": "<",
    "lte": "<=",
}
_CONDITION_OPERATORS = frozenset(
    {
        *_CONDITION_VALUELESS_OPERATORS,
        *_CONDITION_MULTI_VALUE_OPERATORS,
        *_CONDITION_BINARY_OPERATORS.keys(),
        "contains",
        "not_contains",
        "like",
        "not_like",
    }
)


def _is_sql_literal_value(value: object) -> TypeGuard[_SqlLiteralValue]:
    return isinstance(value, (str, int, float, bool))


@dataclass(frozen=True)
class _FactOperand:
    """One resolved fact operand (the single metric, or one ratio side).

    ``row_filters`` is the effective named-filter set (legacy single
    ``row_filter`` already folded in), ``filter_sql`` is the optional free-text
    WHERE fragment, and ``conditions`` are visual column/operator/value rows; all
    are resolved to one ANDed WHERE expression at collection time.
    """

    fact_table_id: uuid.UUID
    aggregation: MetricAggregation
    measure_column: str | None
    distinct_column: str | None
    row_filters: tuple[str, ...]
    filter_sql: str | None
    conditions: tuple[_FactCondition, ...]


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
        row_filters=_effective_filter_names(raw),
        filter_sql=_config_str(raw, "filter_sql"),
        conditions=_conditions_from_config(raw),
    )


def _conditions_from_config(raw: Mapping[str, object]) -> tuple[_FactCondition, ...]:
    raw_conditions = raw.get("conditions", [])
    if raw_conditions is None:
        return ()
    if not isinstance(raw_conditions, list):
        msg = "fact operand conditions must be a list"
        raise ScanError(msg)

    conditions: list[_FactCondition] = []
    for raw_condition in raw_conditions:
        if not isinstance(raw_condition, Mapping):
            msg = "fact operand condition entries must be objects"
            raise ScanError(msg)
        column = raw_condition.get("column")
        operator = raw_condition.get("operator")
        if not isinstance(column, str) or not isinstance(operator, str):
            msg = "fact operand condition requires column and operator"
            raise ScanError(msg)
        try:
            column = validate_identifier(column)
        except ValueError as exc:
            msg = f"fact operand condition has invalid column {column!r}"
            raise ScanError(msg) from exc
        if operator not in _CONDITION_OPERATORS:
            msg = f"fact operand condition has unsupported operator {operator!r}"
            raise ScanError(msg)
        conditions.append(
            _FactCondition(column=column, operator=operator, value=raw_condition.get("value"))
        )
    return tuple(conditions)


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


def _resolve_named_filter_fragment(fact_table: FactTable, name: str) -> str:
    """Resolve one named row filter to its validated boolean WHERE fragment.

    ``name`` must match one of the fact table's stored row filters by NAME; the
    associated fragment is re-validated here as defence in depth. Raises a
    ``ScanError`` for an unknown name.
    """
    for row_filter in fact_table.row_filters or []:
        if isinstance(row_filter, Mapping) and row_filter.get("name") == name:
            fragment = row_filter.get("sql")
            if isinstance(fragment, str) and fragment:
                return validate_sql_fragment(fragment)
    msg = f"row filter {name!r} is not defined on fact table {fact_table.id}"
    raise ScanError(msg)


def _condition_literal(value: object, dialect: SqlDialect) -> str:
    if not _is_sql_literal_value(value):
        msg = "fact operand condition value must be a scalar"
        raise ScanError(msg)
    try:
        return quote_sql_literal(value, dialect)
    except ValueError as exc:
        msg = f"fact operand condition value is invalid: {exc}"
        raise ScanError(msg) from exc


def _condition_scalar_literal(
    value: object,
    *,
    dialect: SqlDialect,
    time_kind: TimeKind,
    column_type: str | None,
) -> str:
    """One comparison literal, typed as a timestamp when the column is a time column.

    A bare ``'2026-01-01 00:00:00'`` *parses* on all three engines, so this is not a
    syntax fix — it is the UTC contract in :mod:`tripl.core.bucketing`. An offset-less
    literal is re-read in the COLUMN's timezone (ClickHouse) or the SESSION's
    (PostgreSQL), which silently shifts the comparison; the typed literal pins UTC the
    same way the adapters' own window bounds do.

    Only a column whose INTROSPECTED type is a time type is retyped, and only when the
    value actually parses as a timestamp. Anything else falls through to the plain
    literal — a STRING column holding ``'2026-01-01'`` still compares as a string.
    """
    if time_kind is not TimeKind.unsupported and isinstance(value, str):
        moment = parse_utc_timestamp(value)
        if moment is not None:
            return quote_timestamp_literal(moment, dialect, kind=time_kind)

    normalized_type = column_type.strip().lower() if column_type is not None else None
    if normalized_type == "number":
        if isinstance(value, bool):
            msg = "numeric column requires a numeric value, not a boolean"
            raise ScanError(msg)
        literal = _condition_literal(value, dialect)
        if isinstance(value, str) and literal.startswith("'"):
            msg = "numeric column requires a numeric value"
            raise ScanError(msg)
        return literal
    if normalized_type == "bool":
        if isinstance(value, bool):
            return _condition_literal(value, dialect)
        if isinstance(value, str) and value.strip().lower() in {"true", "false"}:
            return _condition_literal(value, dialect)
        msg = "boolean column requires true or false"
        raise ScanError(msg)
    if normalized_type == "string":
        if not _is_sql_literal_value(value):
            msg = "fact operand condition value must be a scalar"
            raise ScanError(msg)
        text = str(value).lower() if isinstance(value, bool) else str(value)
        try:
            return quote_sql_string_literal(text, dialect)
        except ValueError as exc:
            msg = f"fact operand condition value is invalid: {exc}"
            raise ScanError(msg) from exc
    return _condition_literal(value, dialect)


def _condition_text(value: object, dialect: SqlDialect) -> str:
    if not _is_sql_literal_value(value):
        msg = "fact operand condition value must be a scalar"
        raise ScanError(msg)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _condition_literal(value, dialect)
    text = value.strip()
    if not text:
        msg = "fact operand condition value must not be empty"
        raise ScanError(msg)
    return text


def _escape_like_wildcards(text: str) -> str:
    """Neutralise ``%`` and ``_`` so ``contains`` means *contains* (tripl-jfm3.111).

    ``contains`` is a substring test in the UI, but it compiled to a bare
    ``LIKE '%value%'``, so a value holding a wildcard silently widened the match:
    ``contains "100%"`` matched every row starting ``100``, and ``contains "a_b"``
    matched ``axb``. Nothing raised — the metric was simply computed over the
    wrong rows. ``like`` / ``not_like`` deliberately do NOT come through here:
    there the pattern is the point.

    The escape character is a backslash and no ``ESCAPE`` clause is emitted,
    because all three dialects converge on it once their own literal quoting has
    run: ``quote_sql_string_literal`` doubles backslashes for ClickHouse and
    BigQuery and leaves them alone for PostgreSQL (``standard_conforming_strings``),
    so a pattern of ``\\%`` here reaches every engine as the value ``\\%`` — an
    escaped percent, which is LIKE's default reading in all three. Backslash is
    doubled FIRST so a value containing one cannot escape the escape.
    """
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _condition_list_literals(
    value: object,
    *,
    dialect: SqlDialect,
    time_kind: TimeKind,
    column_type: str | None,
) -> list[str]:
    values: list[object]
    if isinstance(value, list):
        values = list(value)
    elif isinstance(value, str):
        values = [part.strip() for part in value.split(",")]
    else:
        values = [value]

    literals = [
        _condition_scalar_literal(
            item,
            dialect=dialect,
            time_kind=time_kind,
            column_type=column_type,
        )
        for item in values
        if not (isinstance(item, str) and not item)
    ]
    if not literals:
        msg = "fact operand IN condition requires at least one value"
        raise ScanError(msg)
    return literals


def _resolve_condition_fragment(
    condition: _FactCondition,
    *,
    dialect: SqlDialect,
    column_types: Mapping[str, str] | None = None,
) -> str:
    """Compile ONE visual condition into a boolean WHERE fragment for ``dialect``.

    Dialect-aware on three axes, each of which used to be a latent worker crash:

    * **Identifier quoting.** The column is quoted for the selected engine, so a
      reserved name (``order``, ``select``) works. Unquoted, it is a syntax error on
      PostgreSQL and BigQuery while ClickHouse happily accepts it (verified live) —
      the exact asymmetry that let this ship.
    * **String escaping.** ``quote_sql_literal`` now escapes per dialect. BigQuery has
      no ``''`` escape, so before this every filter value containing an apostrophe was
      a hard GoogleSQL parse error raised inside a Celery worker.
    * **Timestamp literals.** A time column's bound is emitted as a UTC-pinned typed
      literal (see ``_condition_scalar_literal``).

    Security: the column still clears ``validate_identifier``'s allowlist regex FIRST
    (inside ``quote_identifier``), and every value still becomes a quoted/escaped
    literal — there are no bound parameters and no new path by which user input
    reaches the statement unescaped.
    """
    quoted = quote_identifier(condition.column, dialect)
    operator = condition.operator
    value = condition.value
    time_kind = time_kind_of(condition.column, column_types)
    column_type = column_types.get(condition.column) if column_types is not None else None

    if operator == "is_null":
        return f"{quoted} IS NULL"
    if operator == "is_not_null":
        return f"{quoted} IS NOT NULL"
    if operator == "is_true":
        return f"{quoted} = TRUE"
    if operator == "is_false":
        return f"{quoted} = FALSE"

    if operator in _CONDITION_BINARY_OPERATORS:
        if value is None:
            msg = f"fact operand condition {operator!r} requires a value"
            raise ScanError(msg)
        try:
            literal = _condition_scalar_literal(
                value,
                dialect=dialect,
                time_kind=time_kind,
                column_type=column_type,
            )
        except ScanError as exc:
            if column_type is not None and str(exc).startswith("numeric column"):
                msg = f"numeric column {condition.column!r} requires a numeric value"
                raise ScanError(msg) from exc
            raise
        return f"{quoted} {_CONDITION_BINARY_OPERATORS[operator]} {literal}"

    if operator in _CONDITION_MULTI_VALUE_OPERATORS:
        if value is None:
            msg = f"fact operand condition {operator!r} requires a value"
            raise ScanError(msg)
        keyword = "NOT IN" if operator == "not_in" else "IN"
        try:
            literals = _condition_list_literals(
                value,
                dialect=dialect,
                time_kind=time_kind,
                column_type=column_type,
            )
        except ScanError as exc:
            if column_type is not None and str(exc).startswith("numeric column"):
                msg = f"numeric column {condition.column!r} requires numeric values"
                raise ScanError(msg) from exc
            raise
        return f"{quoted} {keyword} ({', '.join(literals)})"

    if operator in {"like", "not_like", "contains", "not_contains"}:
        if value is None:
            msg = f"fact operand condition {operator!r} requires a value"
            raise ScanError(msg)
        text = _condition_text(value, dialect)
        pattern = (
            f"%{_escape_like_wildcards(text)}%"
            if operator in {"contains", "not_contains"}
            else text
        )
        keyword = "NOT LIKE" if operator in {"not_like", "not_contains"} else "LIKE"
        try:
            literal = quote_sql_string_literal(pattern, dialect)
        except ValueError as exc:
            msg = f"fact operand condition value is invalid: {exc}"
            raise ScanError(msg) from exc
        return f"{quoted} {keyword} {literal}"

    msg = f"fact operand condition has unsupported operator {operator!r}"
    raise ScanError(msg)


def _dialect_for_data_source(ds: DataSource) -> SqlDialect:
    """The SQL dialect a data source's filters/queries must be compiled for.

    A ``db_type`` with no dialect is a configuration error, and it is raised as a
    ``ScanError`` so it surfaces on the metric like every other collection failure
    rather than as an unhandled worker crash.
    """
    try:
        return dialect_for_db_type(ds.db_type)
    except ValueError as exc:
        raise ScanError(str(exc)) from exc


def _fact_column_types(fact_table: FactTable) -> dict[str, str]:
    """``{column: warehouse_type}`` from the fact table's introspected columns."""
    types: dict[str, str] = {}
    for column in fact_table.columns or []:
        if not isinstance(column, Mapping):
            continue
        name = column.get("name")
        type_name = column.get("type")
        if isinstance(name, str) and isinstance(type_name, str):
            types[name] = type_name
    return types


def _resolve_combined_filter(
    fact_table: FactTable,
    *,
    dialect: SqlDialect,
    row_filters: tuple[str, ...],
    filter_sql: str | None,
    conditions: tuple[_FactCondition, ...] = (),
) -> str | None:
    """Resolve named filters + free-text SQL + conditions into one WHERE.

    Every name in ``row_filters`` is resolved to its stored SQL fragment (by
    NAME), then a present ``filter_sql`` and any structured conditions are
    appended; each fragment is wrapped in parentheses and the list is joined
    with ``" AND "``. An empty set returns ``None`` (no extra WHERE). The SAME
    combined string is consumed by both the per-metric path (a bounded ``WHERE``
    subquery) and the batched path (a conditional aggregate), preserving
    value-identity between them.

    Named filters and ``filter_sql`` are FREE-TEXT and stay explicitly
    dialect-specific: the user wrote them against a particular warehouse, so they
    are re-validated by the dialect-agnostic read-only gate
    (``validate_sql_fragment``) and passed through verbatim. Only the STRUCTURED
    conditions — which we compile — are rendered for ``dialect``.
    """
    fragments = [_resolve_named_filter_fragment(fact_table, name) for name in row_filters]
    if filter_sql is not None:
        fragments.append(validate_sql_fragment(filter_sql))
    column_types = _fact_column_types(fact_table)
    fragments.extend(
        _resolve_condition_fragment(condition, dialect=dialect, column_types=column_types)
        for condition in conditions
    )
    if not fragments:
        return None
    return " AND ".join(f"({fragment})" for fragment in fragments)


def _resolve_fact_operand_query(
    fact_table: FactTable, operand: _FactOperand, *, dialect: SqlDialect
) -> str:
    """Resolve a fact operand's base query, applying its combined row filter.

    The base query is the fact table's stored ``sql``. The operand's effective
    named filters and ``filter_sql`` are assembled into one ANDed boolean
    expression (see ``_resolve_combined_filter``); when present it wraps the
    source in a bounded ``WHERE`` subquery, else the source is returned as-is.

    The wrapper holds for a CTE-backed fact source too: ``SELECT * FROM (WITH x AS
    (...) SELECT * FROM x) AS _filtered WHERE ...`` is valid on ClickHouse,
    PostgreSQL and BigQuery alike (verified against live engines).
    """
    source = fact_table.sql
    combined = _resolve_combined_filter(
        fact_table,
        dialect=dialect,
        row_filters=operand.row_filters,
        filter_sql=operand.filter_sql,
        conditions=operand.conditions,
    )
    if combined is None:
        return source
    return f"SELECT * FROM ({source}) AS _filtered WHERE {combined}"


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
    dialect: SqlDialect,
    interval_code: str,
    chunk_from: datetime,
    chunk_to: datetime,
) -> tuple[dict[datetime, float], str, str | None]:
    """Run one fact operand's bucketed aggregate over a chunk window.

    Returns ``(values_by_bucket, base_query, validated_measure)`` so a SINGLE
    caller can reuse the base query / measure for its breakdown pass.
    """
    base_query = _resolve_fact_operand_query(fact_table, operand, dialect=dialect)
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
        interval_code,
        operand.aggregation,
        measure,
        [],
        [],
        None,
        chunk_from,
        chunk_to,
        limit=METRIC_QUERY_ROW_LIMIT,
    )
    values = {_coerce_bucket(row[0], interval_code): _coerce_value(row[-1]) for row in rows}
    return values, base_query, measure


def _metric_breakdown_columns(definition: MetricDefinition) -> list[str]:
    """Return the metric's configured breakdown dimensions in collection order."""
    breakdown_columns: list[str] = list(definition.breakdown_columns or [])
    for extra in (definition.app_version_column, definition.platform_column):
        if extra and extra not in breakdown_columns:
            breakdown_columns.append(extra)
    return breakdown_columns


def _ratio_breakdown_value(
    numerator_cell: object,
    denominator_cell: object,
) -> float | None:
    """Compute one grouped ratio cell with the same zero-safe semantics as values."""
    denominator = 0.0 if denominator_cell is None else _coerce_value(denominator_cell)
    if denominator == 0:
        return None
    numerator = 0.0 if numerator_cell is None else _coerce_value(numerator_cell)
    return numerator / denominator


def _coerce_compare_bound(dt: datetime) -> datetime:
    """Normalize collection-window bounds for comparison with coerced buckets."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _append_ratio_breakdown_rows(
    rows_out: list[dict[str, object]],
    *,
    definition: MetricDefinition,
    rows: list[tuple[object, ...]],
    interval_code: str,
    time_from: datetime,
    time_to: datetime,
    breakdown_column: str,
    numerator_index: int,
    denominator_index: int,
) -> None:
    """Append finite ratio rows from one multi-aggregate breakdown result."""
    compare_from = _coerce_compare_bound(time_from)
    compare_to = _coerce_compare_bound(time_to)
    for row in rows:
        bucket = _coerce_bucket(row[0], interval_code)
        if not (compare_from <= bucket < compare_to):
            continue
        value = _ratio_breakdown_value(row[numerator_index], row[denominator_index])
        if value is None:
            continue
        rows_out.append(
            {
                "id": uuid.uuid4(),
                "metric_definition_id": definition.id,
                "scan_config_id": None,
                "bucket": bucket,
                "breakdown_column": breakdown_column,
                "breakdown_value": str(row[1])[:MAX_BREAKDOWN_VALUE_LENGTH],
                "is_other": bool(row[2]),
                "value": value,
            }
        )


def _collect_fact_breakdown_rows(
    session: Session,
    *,
    adapter: BaseAdapter,
    definition: MetricDefinition,
    base_query: str,
    time_column: str,
    interval_code: str,
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
    breakdown_columns = _metric_breakdown_columns(definition)
    if not breakdown_columns:
        return 0

    rows_out: list[dict[str, object]] = []
    for column in breakdown_columns:
        _cols, _json_value_names, rows = adapter.get_time_bucketed_aggregate_breakdown(
            base_query,
            time_column,
            interval_code,
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
                    "bucket": _coerce_bucket(row[0], interval_code),
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


def _collect_fact_ratio_breakdown_rows(
    session: Session,
    *,
    adapter: BaseAdapter,
    definition: MetricDefinition,
    fact_table: FactTable,
    numerator_op: _FactOperand,
    denominator_op: _FactOperand,
    dialect: SqlDialect,
    interval_code: str,
    chunk_from: datetime,
    chunk_to: datetime,
) -> int:
    """Collect same-table ratio breakdown values for one fact-metric chunk."""
    breakdown_columns = _metric_breakdown_columns(definition)
    if not breakdown_columns:
        return 0

    allowed_columns = {column.name for column in adapter.get_columns(fact_table.sql)}
    numerator_measure, numerator_filter = _resolve_batch_operand(
        numerator_op,
        fact_table=fact_table,
        allowed_columns=allowed_columns,
        dialect=dialect,
    )
    denominator_measure, denominator_filter = _resolve_batch_operand(
        denominator_op,
        fact_table=fact_table,
        allowed_columns=allowed_columns,
        dialect=dialect,
    )

    rows_out: list[dict[str, object]] = []
    for column in breakdown_columns:
        registry = _SpecRegistry()
        numerator_key = registry.register(
            aggregation=numerator_op.aggregation,
            measure=numerator_measure,
            filter_sql=numerator_filter,
        )
        denominator_key = registry.register(
            aggregation=denominator_op.aggregation,
            measure=denominator_measure,
            filter_sql=denominator_filter,
        )
        col_names, rows = adapter.get_time_bucketed_multi_aggregate_breakdown(
            fact_table.sql,
            fact_table.timestamp_column,
            interval_code,
            column,
            registry.specs,
            chunk_from,
            chunk_to,
            values_limit=definition.breakdown_values_limit,
            limit=METRIC_QUERY_ROW_LIMIT,
        )
        index_by_name = {name: index for index, name in enumerate(col_names)}
        _append_ratio_breakdown_rows(
            rows_out,
            definition=definition,
            rows=list(rows),
            interval_code=interval_code,
            time_from=chunk_from,
            time_to=chunk_to,
            breakdown_column=column,
            numerator_index=index_by_name[numerator_key],
            denominator_index=index_by_name[denominator_key],
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


def _collect_fact(
    session: Session,
    *,
    definition: MetricDefinition,
    window: tuple[datetime, datetime] | None = None,
) -> dict[str, object]:
    """Collect a ``fact`` metric: an aggregation over a FactTable per bucket.

    SINGLE collects one operand series (+ optional per-dimension breakdowns).
    RATIO divides a numerator series by a denominator series (each over a —
    possibly different — FactTable); a zero/absent denominator maps to ``None``
    (divide-by-zero), which the NOT-NULL row builder drops. ``window`` overrides
    the resume window for a manual backfill.
    """
    if definition.interval is None:
        msg = "fact metric requires an interval"
        raise ScanError(msg)
    interval_spec = get_interval(definition.interval)
    delta = interval_spec.delta
    time_from, time_to = _effective_value_window(
        session,
        metric_definition_id=definition.id,
        interval_code=interval_spec.code,
        window_override=window,
    )
    composition = _resolve_fact_composition(definition)
    if composition is MetricComposition.ratio:
        summary = _collect_fact_ratio(
            session,
            definition=definition,
            interval_spec=interval_spec,
            delta=delta,
            time_from=time_from,
            time_to=time_to,
        )
    else:
        summary = _collect_fact_single(
            session,
            definition=definition,
            interval_spec=interval_spec,
            delta=delta,
            time_from=time_from,
            time_to=time_to,
        )
    # Private orchestration metadata: the task removes it before returning its
    # public summary and persists it as source-grid progress even for zero rows.
    summary["_collection_window_to"] = time_to
    return summary


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
        row_filters=_effective_filter_names(config),
        filter_sql=_config_str(config, "filter_sql"),
        conditions=_conditions_from_config(config),
    )
    ds = session.get(DataSource, fact_table.data_source_id)
    if ds is None:
        msg = "DataSource for fact metric not found"
        raise ScanError(msg)
    interval_code = interval_spec.code
    dialect = _dialect_for_data_source(ds)

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
                dialect=dialect,
                interval_code=interval_code,
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
                interval_code=interval_code,
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
    dropped by the NOT-NULL row builder. Breakdown rows are supported for the
    same-table case: both operand aggregates are sliced by the same dimension
    values in one grouped query, then divided per ``(bucket, value)``.
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
    breakdown_columns = _metric_breakdown_columns(definition)
    if breakdown_columns and numerator_ft.id != denominator_ft.id:
        msg = (
            "ratio fact metric breakdowns require numerator and denominator "
            "to use the same fact table"
        )
        raise ScanError(msg)
    interval_code = interval_spec.code
    numerator_dialect = _dialect_for_data_source(numerator_ds)
    denominator_dialect = _dialect_for_data_source(denominator_ds)

    numerator_adapter = _build_adapter(numerator_ds)
    total_values = 0
    total_breakdowns = 0
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
                    dialect=numerator_dialect,
                    interval_code=interval_code,
                    chunk_from=chunk_from,
                    chunk_to=chunk_to,
                )
                denominator_values, _dq, _dm = _aggregate_fact_window(
                    denominator_adapter,
                    fact_table=denominator_ft,
                    operand=denominator_op,
                    dialect=denominator_dialect,
                    interval_code=interval_code,
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
                if breakdown_columns:
                    total_breakdowns += _collect_fact_ratio_breakdown_rows(
                        session,
                        adapter=numerator_adapter,
                        definition=definition,
                        fact_table=numerator_ft,
                        numerator_op=numerator_op,
                        denominator_op=denominator_op,
                        dialect=numerator_dialect,
                        interval_code=interval_code,
                        chunk_from=chunk_from,
                        chunk_to=chunk_to,
                    )
                session.commit()
        finally:
            denominator_adapter.close()
    finally:
        numerator_adapter.close()

    return {"values": total_values, "breakdown_values": total_breakdowns}


# ── batched fact collection ──────────────────────────────────────────────────
#
# The per-metric path above runs one warehouse query per metric (per operand for
# a ratio, plus one per breakdown column). The batched path below collapses every
# fact metric of a fact table into ONE multi-aggregate scan (plus one scan per
# distinct breakdown dimension), turning each per-metric row filter into a
# per-aggregate conditional so metrics with different filters still share one
# scan. The per-bucket VALUES are identical to the per-metric path: an unfiltered
# aggregate over the fact SQL equals the single-aggregate path, and a conditional
# aggregate equals the same aggregate over the row-filtered subquery.


def _resolve_fact_operand_filter(
    operand: _FactOperand, *, fact_table: FactTable, dialect: SqlDialect
) -> str | None:
    """Resolve an operand's combined WHERE fragment for the batched path.

    Unlike ``_resolve_fact_operand_query`` (which wraps the source in a bounded
    ``WHERE`` subquery for the single-aggregate path), this returns just the
    combined boolean fragment so it can be injected as a per-aggregate
    conditional in a shared multi-aggregate scan. The fragment is built by the
    SAME ``_resolve_combined_filter`` the per-metric path uses — and now for the
    SAME dialect — so the conditional aggregate computes the identical value.
    ``None`` means no filter.
    """
    return _resolve_combined_filter(
        fact_table,
        dialect=dialect,
        row_filters=operand.row_filters,
        filter_sql=operand.filter_sql,
        conditions=operand.conditions,
    )


# A spec's dedup identity: same aggregation, same measure/distinct column and
# the same combined filter expression aggregate to the SAME warehouse column, so
# two metrics needing the same aggregate share one column in the scan. The
# combined filter string (built deterministically by ``_resolve_combined_filter``)
# is the true identity, so equal effective filters — whatever named/free-text mix
# produced them — dedup to one column.
_SpecDedupKey = tuple[MetricAggregation, str | None, str | None]


@dataclass
class _SpecRegistry:
    """Dedup'd ``AggregateSpec`` list for one scan (a fact table or a breakdown).

    ``register`` returns the stable column alias key for an operand, reusing the
    same key (and column) for operands that share aggregation / measure / filter.
    """

    specs: list[AggregateSpec] = field(default_factory=list)
    _keys: dict[_SpecDedupKey, str] = field(default_factory=dict)

    def register(
        self,
        *,
        aggregation: MetricAggregation,
        measure: str | None,
        filter_sql: str | None,
    ) -> str:
        dedup: _SpecDedupKey = (aggregation, measure, filter_sql)
        key = self._keys.get(dedup)
        if key is None:
            key = f"k{len(self.specs)}"
            self._keys[dedup] = key
            self.specs.append(
                AggregateSpec(
                    key=key,
                    aggregation=aggregation,
                    column=measure,
                    filter_sql=filter_sql,
                )
            )
        return key


@dataclass(frozen=True)
class _BreakdownPlan:
    """One breakdown dimension a single metric reads from a shared scan."""

    column: str
    values_limit: int | None
    spec_key: str


@dataclass(frozen=True)
class _RatioBreakdownPlan:
    """One breakdown dimension a ratio metric reads from a shared scan."""

    column: str
    values_limit: int | None
    numerator_key: str
    denominator_key: str


@dataclass(frozen=True)
class _SingleMetricPlan:
    definition: MetricDefinition
    fact_table_id: uuid.UUID
    spec_key: str
    window: tuple[datetime, datetime]
    breakdowns: tuple[_BreakdownPlan, ...]


@dataclass(frozen=True)
class _RatioMetricPlan:
    definition: MetricDefinition
    numerator_fact_table_id: uuid.UUID
    numerator_key: str
    denominator_fact_table_id: uuid.UUID
    denominator_key: str
    window: tuple[datetime, datetime]
    breakdowns: tuple[_RatioBreakdownPlan, ...]


# A breakdown scan is keyed by (fact table, column, values_limit): the top-N
# "Other" rollup depends on values_limit, so metrics that share a column but not
# a limit cannot share one scan (different rollups). Everything else (the per-spec
# aggregate columns) is layered on top of the shared GROUP BY.
_BreakdownScanKey = tuple[uuid.UUID, str, int | None]


def _resolve_batch_operand(
    operand: _FactOperand,
    *,
    fact_table: FactTable,
    allowed_columns: set[str],
    dialect: SqlDialect,
) -> tuple[str | None, str | None]:
    """Validate one operand's measure column and resolve its row filter fragment.

    Returns ``(validated_measure, filter_sql)``. Mirrors ``_aggregate_fact_window``'s
    measure validation (empty allowlist -> ``ScanError``) so the batched path
    enforces the same column guard as the per-metric path — and compiles the filter
    for the SAME ``dialect``, so the conditional aggregate and the bounded-subquery
    path stay value-identical.
    """
    measure = _fact_operand_measure(operand)
    if requires_measure(operand.aggregation):
        if measure is None:
            msg = (
                f"aggregation {operand.aggregation.value!r} requires a "
                "measure_column / distinct_column"
            )
            raise ScanError(msg)
        if not allowed_columns:
            msg = "fact table query returned no columns; cannot validate measure column"
            raise ScanError(msg)
        measure = validate_measure_column(measure, allowed_columns)
    _validate_condition_columns(operand, allowed_columns=allowed_columns)
    filter_sql = _resolve_fact_operand_filter(operand, fact_table=fact_table, dialect=dialect)
    return measure, filter_sql


def _validate_condition_columns(operand: _FactOperand, *, allowed_columns: set[str]) -> None:
    """Hold condition columns to the same allowlist a measure column answers to.

    Condition columns clear ``validate_identifier``'s regex when the metric is
    saved, and ``_verify_fact_operand`` checks them against the fact table's
    columns AS THEY WERE THEN. Nothing rechecks them at collection time, so a
    column dropped or renamed in the warehouse afterwards compiles into a query
    that fails deep inside a worker — or, through the generated-SQL disclosure,
    into SQL a user is invited to copy and run. Fail here instead, naming the
    column, the way an unknown measure column already does.
    """
    if not operand.conditions:
        return
    if not allowed_columns:
        msg = "fact table query returned no columns; cannot validate condition columns"
        raise ScanError(msg)
    unknown = sorted(
        {
            condition.column
            for condition in operand.conditions
            if condition.column not in allowed_columns
        }
    )
    if unknown:
        listed = ", ".join(repr(column) for column in unknown)
        msg = f"condition column(s) {listed} are not columns of the fact table"
        raise ScanError(msg)


def _index_multi_aggregate(
    col_names: list[str], rows: list[tuple[object, ...]], interval_code: str
) -> dict[str, dict[datetime, float]]:
    """Index a multi-aggregate result into ``{spec_key: {bucket: value}}``.

    ``col_names`` is ``["bucket", key1, key2, ...]``. ``NULL`` cells (a
    conditional aggregate over an empty group, e.g. ``avgIf`` with no matching
    rows) are skipped so the bucket reads as absent for that key — matching the
    per-metric path, where a filtered scan would not emit that bucket at all.
    """
    out: dict[str, dict[datetime, float]] = {name: {} for name in col_names[1:]}
    for row in rows:
        bucket = _coerce_bucket(row[0], interval_code)
        for index, name in enumerate(col_names[1:], start=1):
            cell = row[index]
            if cell is None:
                continue
            out[name][bucket] = _coerce_value(cell)
    return out


def _clip_series(
    series: Mapping[datetime, float], window: tuple[datetime, datetime]
) -> dict[datetime, float]:
    """Restrict a per-bucket series to a metric's own ``[from, to)`` window."""
    time_from, time_to = window
    return {bucket: value for bucket, value in series.items() if time_from <= bucket < time_to}


def _merge_multi_aggregate(
    dst: dict[str, dict[datetime, float]], src: Mapping[str, dict[datetime, float]]
) -> None:
    """Merge one chunk's ``{spec_key: {bucket: value}}`` into the accumulator.

    Chunks are interval-aligned (see ``_iter_window_chunks``), so a bucket never
    straddles two chunks and the merged series is IDENTICAL to what a single
    covering scan would have produced — value-identity is preserved.
    """
    for key, bucket_values in src.items():
        dst.setdefault(key, {}).update(bucket_values)


def _batch_chunk_interval_code(definitions: list[MetricDefinition]) -> str | None:
    """Smallest ``replay_chunk_interval`` configured across the group's metrics.

    The batch's covering window is chunked by the most aggressive (smallest)
    chunk any member requested, so no member's warehouse scan ends up wider than
    it would have been on the per-metric path. ``None`` (no member configures
    chunking) keeps the legacy single covering query. Unknown codes are ignored
    so one metric's bad config never aborts the whole group.
    """
    codes = {definition.replay_chunk_interval for definition in definitions}
    deltas: list[tuple[str, timedelta]] = []
    for code in codes:
        if not code:
            continue
        try:
            deltas.append((code, get_interval(code).delta))
        except ValueError:
            logger.warning("Ignoring unknown replay_chunk_interval %r in batch", code)
    if not deltas:
        return None
    return min(deltas, key=lambda item: item[1])[0]


def _stamp_metric_success(
    session: Session,
    definition: MetricDefinition,
    *,
    window_to: datetime | None = None,
) -> None:
    """Mark a metric successful and persist its source-window watermark."""
    definition.last_collected_at = datetime.now(UTC)
    if window_to is not None and (
        definition.last_collection_window_to is None
        or to_utc(window_to) > to_utc(definition.last_collection_window_to)
    ):
        definition.last_collection_window_to = window_to
    definition.last_collection_status = COLLECTION_STATUS_SUCCESS
    definition.last_collection_error = None
    session.commit()


def _stamp_batch_dependency_error(session: Session, definition: MetricDefinition) -> None:
    """Report a sibling's batch failure on the clicked metric WITHOUT dropping its data.

    The clicked metric is what the UI's collection watcher polls, so a partially
    failed shared batch has to surface through it. Its own scan succeeded and was
    already committed by ``_stamp_metric_success``; routing this through
    ``_stamp_metric_error`` would roll that commit's successor transaction back
    and discard correct rows because an unrelated metric failed. Overwrite the
    status only, leaving the collected values and the watermark in place.
    """
    definition.last_collection_status = COLLECTION_STATUS_ERROR
    definition.last_collection_error = (
        "One or more dependent metrics failed during the shared collection batch"
    )
    session.commit()


def _stamp_metric_error(session: Session, definition: MetricDefinition, exc: Exception) -> None:
    """Roll back any partial writes for one metric and persist a sanitized error."""
    try:
        session.rollback()
        definition.last_collection_status = COLLECTION_STATUS_ERROR
        definition.last_collection_error = user_facing_error(exc)
        session.commit()
    except Exception:  # pragma: no cover - best-effort status write
        session.rollback()


@dataclass
class _FactBatchContext:
    """Lazily-built fact-table / data-source / adapter caches for one batch."""

    session: Session
    fact_tables: dict[uuid.UUID, FactTable] = field(default_factory=dict)
    adapters: dict[uuid.UUID, BaseAdapter] = field(default_factory=dict)
    columns: dict[uuid.UUID, set[str]] = field(default_factory=dict)
    dialects: dict[uuid.UUID, SqlDialect] = field(default_factory=dict)

    def resolve(
        self, fact_table_id: uuid.UUID | None, *, project_id: uuid.UUID
    ) -> tuple[FactTable, BaseAdapter]:
        fact_table = self.fact_tables.get(fact_table_id) if fact_table_id else None
        if fact_table is None:
            fact_table = _load_fact_table(self.session, fact_table_id, project_id=project_id)
            self.fact_tables[fact_table.id] = fact_table
        # ``_load_fact_table`` rejects a fact table without a bound data source.
        data_source_id = fact_table.data_source_id
        assert data_source_id is not None
        adapter = self.adapters.get(data_source_id)
        if adapter is None:
            ds = self.session.get(DataSource, data_source_id)
            if ds is None:
                msg = "DataSource for fact metric not found"
                raise ScanError(msg)
            adapter = _build_adapter(ds)
            adapter.test_connection()
            self.adapters[data_source_id] = adapter
            # Cached under the same key as the adapter: the dialect a filter must be
            # compiled for is a property of the data source, not of the fact table.
            self.dialects[data_source_id] = _dialect_for_data_source(ds)
        return fact_table, adapter

    def adapter_for(self, fact_table: FactTable) -> BaseAdapter:
        """Return the cached adapter that serves ``fact_table``'s data source."""
        data_source_id = fact_table.data_source_id
        assert data_source_id is not None
        return self.adapters[data_source_id]

    def dialect_for(self, fact_table: FactTable) -> SqlDialect:
        """Return the SQL dialect ``fact_table``'s data source must be compiled for."""
        data_source_id = fact_table.data_source_id
        assert data_source_id is not None
        return self.dialects[data_source_id]

    def allowed_columns(self, fact_table: FactTable, adapter: BaseAdapter) -> set[str]:
        cached = self.columns.get(fact_table.id)
        if cached is None:
            cached = {column.name for column in adapter.get_columns(fact_table.sql)}
            self.columns[fact_table.id] = cached
        return cached

    def close(self) -> None:
        for adapter in self.adapters.values():
            adapter.close()


def _plan_single_metric(
    context: _FactBatchContext,
    *,
    definition: MetricDefinition,
    window: tuple[datetime, datetime],
    ft_registries: dict[uuid.UUID, _SpecRegistry],
    bd_registries: dict[_BreakdownScanKey, _SpecRegistry],
) -> _SingleMetricPlan:
    """Resolve a single-operand fact metric into a shared-scan plan."""
    if definition.aggregation is None:
        msg = "single fact metric requires an aggregation"
        raise ScanError(msg)
    config = definition.config or {}
    fact_table, adapter = context.resolve(
        definition.fact_table_id, project_id=definition.project_id
    )
    operand = _FactOperand(
        fact_table_id=fact_table.id,
        aggregation=coerce_aggregation(definition.aggregation),
        measure_column=_config_str(config, "measure_column"),
        distinct_column=_config_str(config, "distinct_column"),
        row_filters=_effective_filter_names(config),
        filter_sql=_config_str(config, "filter_sql"),
        conditions=_conditions_from_config(config),
    )
    measure, filter_sql = _resolve_batch_operand(
        operand,
        fact_table=fact_table,
        allowed_columns=context.allowed_columns(fact_table, adapter),
        dialect=context.dialect_for(fact_table),
    )
    registry = ft_registries.setdefault(fact_table.id, _SpecRegistry())
    spec_key = registry.register(
        aggregation=operand.aggregation,
        measure=measure,
        filter_sql=filter_sql,
    )

    breakdown_columns = _metric_breakdown_columns(definition)
    breakdowns: list[_BreakdownPlan] = []
    for column in breakdown_columns:
        scan_key: _BreakdownScanKey = (
            fact_table.id,
            column,
            definition.breakdown_values_limit,
        )
        bd_registry = bd_registries.setdefault(scan_key, _SpecRegistry())
        bd_key = bd_registry.register(
            aggregation=operand.aggregation,
            measure=measure,
            filter_sql=filter_sql,
        )
        breakdowns.append(
            _BreakdownPlan(
                column=column,
                values_limit=definition.breakdown_values_limit,
                spec_key=bd_key,
            )
        )

    return _SingleMetricPlan(
        definition=definition,
        fact_table_id=fact_table.id,
        spec_key=spec_key,
        window=window,
        breakdowns=tuple(breakdowns),
    )


def _plan_ratio_metric(
    context: _FactBatchContext,
    *,
    definition: MetricDefinition,
    window: tuple[datetime, datetime],
    ft_registries: dict[uuid.UUID, _SpecRegistry],
    bd_registries: dict[_BreakdownScanKey, _SpecRegistry],
) -> _RatioMetricPlan:
    """Resolve a ratio fact metric's two operands into shared-scan plans."""
    config = definition.config or {}
    numerator_raw = config.get("numerator")
    denominator_raw = config.get("denominator")
    if not isinstance(numerator_raw, Mapping) or not isinstance(denominator_raw, Mapping):
        msg = "ratio fact metric requires numerator and denominator operands in config"
        raise ScanError(msg)
    keys: list[tuple[uuid.UUID, str]] = []
    operand_plans: list[tuple[_FactOperand, uuid.UUID, str | None, str | None]] = []
    for raw in (numerator_raw, denominator_raw):
        operand = _operand_from_config(raw)
        fact_table, adapter = context.resolve(
            operand.fact_table_id, project_id=definition.project_id
        )
        measure, filter_sql = _resolve_batch_operand(
            operand,
            fact_table=fact_table,
            allowed_columns=context.allowed_columns(fact_table, adapter),
            dialect=context.dialect_for(fact_table),
        )
        registry = ft_registries.setdefault(fact_table.id, _SpecRegistry())
        spec_key = registry.register(
            aggregation=operand.aggregation,
            measure=measure,
            filter_sql=filter_sql,
        )
        keys.append((fact_table.id, spec_key))
        operand_plans.append((operand, fact_table.id, measure, filter_sql))
    (numerator_ft_id, numerator_key), (denominator_ft_id, denominator_key) = keys

    ratio_breakdowns: list[_RatioBreakdownPlan] = []
    breakdown_columns = _metric_breakdown_columns(definition)
    if breakdown_columns:
        if numerator_ft_id != denominator_ft_id:
            msg = (
                "ratio fact metric breakdowns require numerator and denominator "
                "to use the same fact table"
            )
            raise ScanError(msg)
        numerator_op, _num_ft_id, numerator_measure, numerator_filter = operand_plans[0]
        denominator_op, _den_ft_id, denominator_measure, denominator_filter = operand_plans[1]
        for column in breakdown_columns:
            scan_key: _BreakdownScanKey = (
                numerator_ft_id,
                column,
                definition.breakdown_values_limit,
            )
            bd_registry = bd_registries.setdefault(scan_key, _SpecRegistry())
            numerator_bd_key = bd_registry.register(
                aggregation=numerator_op.aggregation,
                measure=numerator_measure,
                filter_sql=numerator_filter,
            )
            denominator_bd_key = bd_registry.register(
                aggregation=denominator_op.aggregation,
                measure=denominator_measure,
                filter_sql=denominator_filter,
            )
            ratio_breakdowns.append(
                _RatioBreakdownPlan(
                    column=column,
                    values_limit=definition.breakdown_values_limit,
                    numerator_key=numerator_bd_key,
                    denominator_key=denominator_bd_key,
                )
            )

    return _RatioMetricPlan(
        definition=definition,
        numerator_fact_table_id=numerator_ft_id,
        numerator_key=numerator_key,
        denominator_fact_table_id=denominator_ft_id,
        denominator_key=denominator_key,
        window=window,
        breakdowns=tuple(ratio_breakdowns),
    )


def _assemble_single_metric(
    session: Session,
    *,
    plan: _SingleMetricPlan,
    results: Mapping[uuid.UUID, Mapping[str, dict[datetime, float]]],
    breakdown_results: Mapping[_BreakdownScanKey, tuple[dict[str, int], list[tuple[object, ...]]]],
    interval_code: str,
) -> tuple[int, int]:
    """Write one single metric's values + breakdowns from the shared scan results.

    Returns ``(values_written, breakdown_values_written)``.
    """
    definition = plan.definition
    series = _clip_series(results.get(plan.fact_table_id, {}).get(plan.spec_key, {}), plan.window)
    value_rows = _build_metric_value_rows(
        metric_definition_id=definition.id,
        scan_config_id=None,
        values=series,
    )
    time_from, time_to = plan.window
    _delete_metric_values_window(
        session,
        metric_definition_id=definition.id,
        time_from=time_from,
        time_to=time_to,
    )
    _upsert_metric_values_rows(session, rows=value_rows)

    breakdown_rows: list[dict[str, object]] = []
    for breakdown in plan.breakdowns:
        scan_key: _BreakdownScanKey = (
            plan.fact_table_id,
            breakdown.column,
            breakdown.values_limit,
        )
        entry = breakdown_results.get(scan_key)
        if entry is None:
            continue
        index_by_key, rows = entry
        value_index = index_by_key[breakdown.spec_key]
        for row in rows:
            bucket = _coerce_bucket(row[0], interval_code)
            if not (time_from <= bucket < time_to):
                continue
            cell = row[value_index]
            if cell is None:
                continue
            breakdown_rows.append(
                {
                    "id": uuid.uuid4(),
                    "metric_definition_id": definition.id,
                    "scan_config_id": None,
                    "bucket": bucket,
                    "breakdown_column": breakdown.column,
                    "breakdown_value": str(row[1])[:MAX_BREAKDOWN_VALUE_LENGTH],
                    "is_other": bool(row[2]),
                    "value": _coerce_value(cell),
                }
            )

    if plan.breakdowns:
        _delete_metric_value_breakdowns_window(
            session,
            metric_definition_id=definition.id,
            time_from=time_from,
            time_to=time_to,
        )
        _upsert_metric_value_breakdown_rows(session, rows=breakdown_rows)

    return len(value_rows), len(breakdown_rows)


def _assemble_ratio_metric(
    session: Session,
    *,
    plan: _RatioMetricPlan,
    results: Mapping[uuid.UUID, Mapping[str, dict[datetime, float]]],
    breakdown_results: Mapping[_BreakdownScanKey, tuple[dict[str, int], list[tuple[object, ...]]]],
    interval_code: str,
) -> tuple[int, int]:
    """Write one ratio metric's values + same-table breakdowns from shared scans."""
    definition = plan.definition
    numerator = _clip_series(
        results.get(plan.numerator_fact_table_id, {}).get(plan.numerator_key, {}), plan.window
    )
    denominator = _clip_series(
        results.get(plan.denominator_fact_table_id, {}).get(plan.denominator_key, {}), plan.window
    )
    values = evaluate_composition(
        MetricComposition.ratio,
        numerator=numerator,
        denominator=denominator,
    )
    value_rows = _build_metric_value_rows(
        metric_definition_id=definition.id,
        scan_config_id=None,
        values=values,
    )
    time_from, time_to = plan.window
    _delete_metric_values_window(
        session,
        metric_definition_id=definition.id,
        time_from=time_from,
        time_to=time_to,
    )
    _upsert_metric_values_rows(session, rows=value_rows)

    breakdown_rows: list[dict[str, object]] = []
    for breakdown in plan.breakdowns:
        scan_key: _BreakdownScanKey = (
            plan.numerator_fact_table_id,
            breakdown.column,
            breakdown.values_limit,
        )
        entry = breakdown_results.get(scan_key)
        if entry is None:
            continue
        index_by_key, rows = entry
        _append_ratio_breakdown_rows(
            breakdown_rows,
            definition=definition,
            rows=rows,
            interval_code=interval_code,
            time_from=time_from,
            time_to=time_to,
            breakdown_column=breakdown.column,
            numerator_index=index_by_key[breakdown.numerator_key],
            denominator_index=index_by_key[breakdown.denominator_key],
        )

    if plan.breakdowns:
        _delete_metric_value_breakdowns_window(
            session,
            metric_definition_id=definition.id,
            time_from=time_from,
            time_to=time_to,
        )
        _upsert_metric_value_breakdown_rows(session, rows=breakdown_rows)

    return len(value_rows), len(breakdown_rows)


def _run_fact_interval_group(
    session: Session,
    *,
    definitions: list[MetricDefinition],
    interval_spec: IntervalSpec,
    window_override: tuple[datetime, datetime] | None = None,
    manual_backfill: bool = False,
    completion_metric_id: uuid.UUID | None = None,
    prior_errors: int = 0,
) -> dict[str, int]:
    """Collect every fact metric of one interval group in shared warehouse scans.

    Builds dedup'd ``AggregateSpec`` lists per fact table (and per breakdown
    dimension), runs ONE multi-aggregate scan per fact table plus one per
    breakdown scan over a covering window, then assembles each metric over its
    OWN window with isolated per-metric error capture. ``window_override``
    replaces each metric's resume window when set; with ``manual_backfill`` it
    only widens it (see ``_effective_value_window``), so a swept-in metric that
    is further behind than the manual window keeps its backlog.
    """
    delta = interval_spec.delta
    interval_code = interval_spec.code
    context = _FactBatchContext(session=session)

    totals = {"metrics": 0, "collected": 0, "errors": 0, "values": 0, "breakdown_values": 0}
    try:
        ft_registries: dict[uuid.UUID, _SpecRegistry] = {}
        bd_registries: dict[_BreakdownScanKey, _SpecRegistry] = {}
        single_plans: list[_SingleMetricPlan] = []
        ratio_plans: list[_RatioMetricPlan] = []
        completion_planning_error: tuple[MetricDefinition, Exception] | None = None

        for definition in definitions:
            totals["metrics"] += 1
            try:
                window = _effective_value_window(
                    session,
                    metric_definition_id=definition.id,
                    interval_code=interval_code,
                    window_override=window_override,
                    manual_backfill=manual_backfill,
                )
                if _resolve_fact_composition(definition) is MetricComposition.ratio:
                    ratio_plans.append(
                        _plan_ratio_metric(
                            context,
                            definition=definition,
                            window=window,
                            ft_registries=ft_registries,
                            bd_registries=bd_registries,
                        )
                    )
                else:
                    single_plans.append(
                        _plan_single_metric(
                            context,
                            definition=definition,
                            window=window,
                            ft_registries=ft_registries,
                            bd_registries=bd_registries,
                        )
                    )
            except Exception as exc:
                logger.exception("Batch planning failed for metric %s", definition.id)
                if definition.id == completion_metric_id:
                    completion_planning_error = (definition, exc)
                else:
                    _stamp_metric_error(session, definition, exc)
                totals["errors"] += 1

        windows = [plan.window for plan in single_plans] + [plan.window for plan in ratio_plans]
        if not windows:
            if completion_planning_error is not None:
                _stamp_metric_error(session, *completion_planning_error)
            return totals
        covering_from = min(window[0] for window in windows)
        covering_to = max(window[1] for window in windows)

        results: dict[uuid.UUID, dict[str, dict[datetime, float]]] = {}
        fact_errors: dict[uuid.UUID, Exception] = {}
        breakdown_results: dict[
            _BreakdownScanKey, tuple[dict[str, int], list[tuple[object, ...]]]
        ] = {}
        breakdown_errors: dict[_BreakdownScanKey, Exception] = {}

        # Bound each warehouse scan's time range the way the per-metric path does:
        # split the covering window into interval-aligned chunks (smallest
        # replay_chunk_interval among the group's metrics) so no single query
        # spans the whole window, which on fine-grained intervals could exceed the
        # task soft_time_limit. Merging the per-chunk results reproduces the same
        # per-bucket series a single covering scan would (value-identity holds).
        chunks = _iter_window_chunks(
            covering_from,
            covering_to,
            interval_delta=delta,
            chunk_interval_code=_batch_chunk_interval_code(definitions),
        )
        for chunk_from, chunk_to in chunks:
            for fact_table_id, registry in ft_registries.items():
                if not registry.specs or fact_table_id in fact_errors:
                    continue
                try:
                    fact_table = context.fact_tables[fact_table_id]
                    adapter = context.adapter_for(fact_table)
                    # Refresh the adapter's column allowlist for THIS fact table's
                    # query (a shared adapter serves several fact tables in turn).
                    adapter.get_columns(fact_table.sql)
                    col_names, rows = adapter.get_time_bucketed_multi_aggregate(
                        fact_table.sql,
                        fact_table.timestamp_column,
                        interval_code,
                        registry.specs,
                        chunk_from,
                        chunk_to,
                        limit=METRIC_QUERY_ROW_LIMIT,
                    )
                    _merge_multi_aggregate(
                        results.setdefault(fact_table_id, {}),
                        _index_multi_aggregate(col_names, rows, interval_code),
                    )
                except Exception as exc:  # noqa: BLE001 - attributed per metric below
                    logger.exception(
                        "Batch multi-aggregate failed for fact table %s", fact_table_id
                    )
                    fact_errors[fact_table_id] = exc

            for scan_key, registry in bd_registries.items():
                if not registry.specs or scan_key in breakdown_errors:
                    continue
                fact_table_id, column, values_limit = scan_key
                try:
                    fact_table = context.fact_tables[fact_table_id]
                    adapter = context.adapter_for(fact_table)
                    adapter.get_columns(fact_table.sql)
                    col_names, rows = adapter.get_time_bucketed_multi_aggregate_breakdown(
                        fact_table.sql,
                        fact_table.timestamp_column,
                        interval_code,
                        column,
                        registry.specs,
                        chunk_from,
                        chunk_to,
                        values_limit=values_limit,
                        limit=METRIC_QUERY_ROW_LIMIT,
                    )
                    index_by_name = {name: index for index, name in enumerate(col_names)}
                    existing = breakdown_results.get(scan_key)
                    if existing is None:
                        breakdown_results[scan_key] = (index_by_name, list(rows))
                    else:
                        existing[1].extend(rows)
                except Exception as exc:  # noqa: BLE001 - attributed per metric below
                    logger.exception("Batch breakdown scan failed for %s", scan_key)
                    breakdown_errors[scan_key] = exc

        plans: list[_SingleMetricPlan | _RatioMetricPlan] = [*single_plans, *ratio_plans]
        plans.sort(
            key=lambda plan: (
                plan.definition.id == completion_metric_id,
                str(plan.definition.id),
            )
        )
        for plan in plans:
            try:
                if isinstance(plan, _SingleMetricPlan):
                    fact_error = fact_errors.get(plan.fact_table_id)
                    if fact_error is not None:
                        raise fact_error
                    for breakdown in plan.breakdowns:
                        bd_error = breakdown_errors.get(
                            (plan.fact_table_id, breakdown.column, breakdown.values_limit)
                        )
                        if bd_error is not None:
                            raise bd_error
                    values_written, breakdown_written = _assemble_single_metric(
                        session,
                        plan=plan,
                        results=results,
                        breakdown_results=breakdown_results,
                        interval_code=interval_code,
                    )
                else:
                    for fact_table_id in (
                        plan.numerator_fact_table_id,
                        plan.denominator_fact_table_id,
                    ):
                        fact_error = fact_errors.get(fact_table_id)
                        if fact_error is not None:
                            raise fact_error
                    for ratio_breakdown in plan.breakdowns:
                        bd_error = breakdown_errors.get(
                            (
                                plan.numerator_fact_table_id,
                                ratio_breakdown.column,
                                ratio_breakdown.values_limit,
                            )
                        )
                        if bd_error is not None:
                            raise bd_error
                    values_written, breakdown_written = _assemble_ratio_metric(
                        session,
                        plan=plan,
                        results=results,
                        breakdown_results=breakdown_results,
                        interval_code=interval_code,
                    )

                _stamp_metric_success(session, plan.definition, window_to=plan.window[1])
                totals["collected"] += 1
                totals["values"] += values_written
                totals["breakdown_values"] += breakdown_written
                # The clicked metric carries the batch's outcome to the UI, but its
                # own rows are already committed above and stay that way: a sibling
                # metric failing is not a reason to discard data this metric
                # collected correctly.
                if plan.definition.id == completion_metric_id and (
                    prior_errors + totals["errors"] > 0
                ):
                    _stamp_batch_dependency_error(session, plan.definition)
            except Exception as exc:
                logger.exception("Batch assembly failed for metric %s", plan.definition.id)
                _stamp_metric_error(session, plan.definition, exc)
                totals["errors"] += 1

        if completion_planning_error is not None:
            _stamp_metric_error(session, *completion_planning_error)

        return totals
    finally:
        context.close()


def _collect_sql(
    session: Session,
    *,
    definition: MetricDefinition,
    window: tuple[datetime, datetime] | None = None,
) -> dict[str, object]:
    """Collect a sql metric: execute the user SELECT and bucket its rows.

    The SELECT must project the configured value column (default ``value``)
    and the configured time column (re-checked here with
    ``validate_select_sql``). Each returned row is floored to the interval;
    later rows for the same bucket overwrite earlier ones. ``window``
    overrides the resume window for a manual backfill.
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
    value_column = _config_str(config, "value_column") or SQL_VALUE_COLUMN

    safe_sql = validate_select_sql(metric_sql, value_column=value_column, time_column=time_column)

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
        time_from, time_to = _effective_value_window(
            session,
            metric_definition_id=definition.id,
            interval_code=interval_spec.code,
            window_override=window,
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
            if value_column not in index_by_name or time_column not in index_by_name:
                msg = f"sql metric must project {value_column!r} and {time_column!r} columns"
                raise ScanError(msg)
            value_idx = index_by_name[value_column]
            time_idx = index_by_name[time_column]
            values: dict[datetime, float] = {}
            for row in rows:
                bucket = _coerce_bucket(row[time_idx], interval_spec.code)
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

    return {"values": total_values, "_collection_window_to": time_to}


def _coerce_bucket(raw: object, interval_code: str) -> datetime:
    """Coerce a projected time cell to an interval-floored aware datetime."""
    dt = raw if isinstance(raw, datetime) else _parse_task_datetime(str(raw))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return floor_to_bucket(dt, interval_code)


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
            interval_spec.code,
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
    # Launder the bucket cell exactly like every sibling collection path does
    # (_aggregate_fact_window, _index_multi_aggregate). A bare cast() was a lie: the
    # adapters disagree on tz-awareness — ClickHouse hands back a NAIVE datetime while
    # PostgreSQL returns the same instant as aware — so the naive key met the aware
    # bucket read back from event_metrics, and every per_distinct_user metric on a
    # ClickHouse source died with "can't compare offset-naive and offset-aware
    # datetimes". _coerce_bucket stamps UTC and floors to the interval (tripl-ju0d).
    return {_coerce_bucket(row[0], interval_spec.code): _coerce_value(row[-1]) for row in rows}


def _collect_event_composition(
    session: Session,
    *,
    definition: MetricDefinition,
    window: tuple[datetime, datetime] | None = None,
) -> dict[str, object]:
    """Collect an event_composition metric from already-stored event_metrics.

    Reads the numerator (and, for ``ratio``, denominator) event-metric series on
    each source scan grid, evaluates the composition per grid, and writes
    ``MetricValue`` rows keyed by that ``scan_config_id``. ``per_distinct_user``
    additionally fetches a warehouse distinct-user denominator per grid.

    ``window`` is accepted for a uniform collector signature but ignored: an
    event_composition metric has no interval of its own — it re-derives from the
    full already-collected event-metric series, so a manual collect simply
    recomputes everything available.
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
def collect_metric_definitions(
    self: object,
    metric_definition_id: str,
    window_from: str | None = None,
    window_to: str | None = None,
    force: bool = False,
) -> dict[str, object]:
    """Collect one catalog metric's per-bucket values into ``metric_values``.

    Dispatches by ``kind`` and stamps ``last_collected_at`` /
    ``last_collection_status`` / ``last_collection_error`` inline (success or a
    sanitized error). The full exception is logged; only a safe summary is
    persisted. An optional ``window_from`` / ``window_to`` pair (ISO strings)
    backfills an explicit recent window for a manual "collect now"; omitted, the
    scheduler's resume window is used. event_composition ignores the window.

    ``force`` is set only by the manual "collect now" trigger: it bypasses the
    active-status skip so a freshly-created (draft) metric still produces data.
    The scheduler always dispatches with ``force=False``, so scheduled collection
    stays active-only.
    """
    session = _get_sync_session()
    definition: MetricDefinition | None = None
    try:
        window = _parse_window_override(window_from, window_to)
        definition = session.get(MetricDefinition, uuid.UUID(metric_definition_id))
        if definition is None:
            msg = f"MetricDefinition {metric_definition_id} not found"
            raise ValueError(msg)

        if not force and definition.status != MetricStatus.active:
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
        summary = collector(session, definition=definition, window=window)
        raw_window_to = summary.pop("_collection_window_to", None)
        collection_window_to = raw_window_to if isinstance(raw_window_to, datetime) else None
        _stamp_metric_success(session, definition, window_to=collection_window_to)
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


def _metric_kind(definition: MetricDefinition) -> MetricKind:
    """Coerce a definition's stored kind to the ``MetricKind`` enum."""
    if isinstance(definition.kind, MetricKind):
        return definition.kind
    return MetricKind(definition.kind)


def _run_fact_metrics_batch(
    session: Session,
    *,
    definitions: list[MetricDefinition],
    window_override: tuple[datetime, datetime] | None = None,
    manual_backfill_all: bool = False,
    completion_metric_id: uuid.UUID | None = None,
) -> dict[str, int]:
    """Group fact metrics by interval and collect each group in shared scans.

    Metrics dispatched together usually share one interval (the scheduler groups
    by interval before dispatch), but grouping here as well keeps the collector
    correct if a caller mixes intervals: each interval has its own bucket grid /
    ``interval_code``, so it gets its own set of shared scans. ``window_override``
    is forwarded to every group for legacy explicit-window callers. A manual
    fact-table refresh sets ``manual_backfill_all`` instead: each interval group
    receives its own bounded backfill window, so a clicked 1h metric never forces
    a dependent 1d/1w metric onto the wrong bucket grid.
    """
    totals = {"metrics": 0, "collected": 0, "errors": 0, "values": 0, "breakdown_values": 0}
    by_interval: dict[str, list[MetricDefinition]] = {}
    for definition in definitions:
        if definition.interval is None:
            totals["metrics"] += 1
            totals["errors"] += 1
            _stamp_metric_error(session, definition, ScanError("fact metric requires an interval"))
            continue
        by_interval.setdefault(str(definition.interval), []).append(definition)

    completion_interval = next(
        (
            str(definition.interval)
            for definition in definitions
            if definition.id == completion_metric_id and definition.interval is not None
        ),
        None,
    )
    ordered_groups = sorted(
        by_interval.items(),
        key=lambda item: (item[0] == completion_interval, item[0]),
    )
    for interval_code, raw_group in ordered_groups:
        group = sorted(
            raw_group,
            key=lambda definition: (
                definition.id == completion_metric_id,
                str(definition.id),
            ),
        )
        group_window = (
            compute_manual_collect_window(interval_code) if manual_backfill_all else window_override
        )
        group_totals = _run_fact_interval_group(
            session,
            definitions=group,
            interval_spec=get_interval(interval_code),
            window_override=group_window,
            manual_backfill=manual_backfill_all,
            completion_metric_id=(
                completion_metric_id if interval_code == completion_interval else None
            ),
            prior_errors=totals["errors"],
        )
        for key, value in group_totals.items():
            totals[key] += value
    return totals


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.metrics.collect_fact_metrics_batch",
    bind=True,
    max_retries=0,
    soft_time_limit=COLLECT_METRIC_DEFINITIONS_SOFT_TIME_LIMIT_SECONDS,
    time_limit=COLLECT_METRIC_DEFINITIONS_TIME_LIMIT_SECONDS,
)
def collect_fact_metrics_batch(
    self: object,
    metric_ids: list[str],
    window_from: str | None = None,
    window_to: str | None = None,
    force: bool = False,
    manual_backfill_all: bool = False,
    completion_metric_id: str | None = None,
) -> dict[str, int]:
    """Collect a batch of fact metrics, sharing one warehouse scan per fact table.

    Loads the requested metrics, keeps only the active ``fact`` ones, and runs the
    batched collector. Per-metric ``last_collected_at`` / ``last_collection_status``
    stamping and error capture happen inside the collector, so one metric failing
    never aborts the others; this wrapper only owns the session lifecycle. An
    optional ``window_from`` / ``window_to`` pair (ISO strings) backfills an
    explicit common window for legacy callers. ``manual_backfill_all`` is used
    when collect-now expands to all fact-table dependants: every compatible
    interval group computes its own bounded manual window, while all metrics on
    the same fact table and interval still share one multi-aggregate query.

    ``force`` is set only by the manual "collect now" trigger: it keeps non-active
    (draft/archived) fact metrics in the batch so a freshly-created metric still
    produces data. The scheduler always dispatches with ``force=False``, so
    scheduled collection stays active-only.
    """
    session = _get_sync_session()
    try:
        window = _parse_window_override(window_from, window_to)
        requested = [uuid.UUID(metric_id) for metric_id in metric_ids]
        loaded = (
            session.execute(select(MetricDefinition).where(MetricDefinition.id.in_(requested)))
            .scalars()
            .all()
        )
        definitions = sorted(
            (
                definition
                for definition in loaded
                if (force or definition.status == MetricStatus.active)
                and _metric_kind(definition) is MetricKind.fact
            ),
            key=lambda definition: str(definition.id),
        )
        if not definitions:
            return {"metrics": 0, "collected": 0, "errors": 0, "values": 0, "breakdown_values": 0}
        return _run_fact_metrics_batch(
            session,
            definitions=definitions,
            window_override=window,
            manual_backfill_all=manual_backfill_all,
            completion_metric_id=(
                uuid.UUID(completion_metric_id) if completion_metric_id is not None else None
            ),
        )
    except Exception:
        logger.exception("Batch fact metric collection failed for %s", metric_ids)
        session.rollback()
        raise
    finally:
        session.close()
