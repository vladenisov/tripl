"""Stateless dry-run previews for draft catalog metrics.

Two flavours, one rule: the metric's SQL is EXECUTED against the selected
warehouse before it can be saved, so a query that only fails inside a Celery
worker — where nobody is watching — fails here instead, in the editor.

* ``preview_sql_metric`` runs a user-authored ``sql``-kind SELECT through the
  SAME safety gate (``validate_select_sql``), dialect lint (``lint_dialect_sql``)
  and time-window wrapping (``get_preview_rows``) the worker's ``_collect_sql``
  uses.
* ``preview_fact_operand`` compiles a draft ``fact`` operand's row filter with
  the worker's OWN ``_resolve_fact_operand_query`` (fed the very config dict a
  save would persist) and executes the result, bounded to one row.

Neither persists anything. Expected user mistakes — bad SQL, an unknown named
filter, a measure column the filtered query does not project, a warehouse
rejection — come back as a 200 payload with ``error`` set so the editor can
render them inline; only auth, unknown project, unknown fact table and unknown
data source use 4xx.
"""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.adapters.errors import WarehouseCapabilityError
from tripl.core.adapters.measure_validator import (
    dialect_for_db_type,
    lint_dialect_sql,
    requires_measure,
    validate_identifier,
    validate_measure_column,
    validate_select_sql,
)
from tripl.core.intervals import get_interval
from tripl.models.data_source import DataSource
from tripl.schemas.metric_definition import (
    FactOperand,
    FactOperandPreviewResponse,
    MetricPreviewPoint,
    MetricPreviewRequest,
    MetricPreviewResponse,
)
from tripl.services.fact_table_service import get_fact_table
from tripl.services.project_lookup import get_project_id_by_slug

logger = logging.getLogger(__name__)

# Preview window: the last N interval buckets ending now. Small enough to stay
# interactive, large enough to show the series shape.
PREVIEW_WINDOW_BUCKETS = 50

# Hard row cap (LIMIT) on the wrapped query; the response flags truncation.
PREVIEW_ROW_LIMIT = 200

# A fact operand's dry run is a SYNTAX/SEMANTICS probe, not a data preview: the
# filtered query is executed over a bounded recent window and capped at one row,
# so pointing it at a huge fact table cannot turn into a full scan on a metered
# warehouse (BigQuery bills bytes scanned).
FACT_PREVIEW_WINDOW = timedelta(days=7)
FACT_PREVIEW_ROW_LIMIT = 1

# Warehouse error strings are trimmed to this many characters so a driver's
# kilobyte-long dump never reaches the client (full context stays in logs).
_ERROR_MESSAGE_MAX_CHARS = 500

# Driver strings that mean the statement never ran: we could not reach or could
# not authenticate against the warehouse. Those messages routinely carry the
# host, the port and the user (that is exactly why
# ``datasource_service._friendly_test_error`` masks them), so they are replaced
# wholesale rather than echoed. Deliberately narrow — bare "connection", "host",
# "port" or "permission" appear in legitimate SQL diagnostics ("permission denied
# for table orders") and masking those would destroy the actionability that is
# the entire point of a dry run.
_UNREACHABLE_HINTS: tuple[str, ...] = (
    "getaddrinfo",
    "name or service not known",
    "connection refused",
    "could not connect",
    "connection reset",
    "network is unreachable",
)
_AUTH_HINTS: tuple[str, ...] = (
    "authentication failed",
    "password authentication",
    "access denied",
    "invalid credentials",
    "invalid_grant",
)
_TIMEOUT_HINTS: tuple[str, ...] = ("timed out", "timeout")


def _trimmed_error(exc: Exception) -> str:
    """A user-safe, bounded error message: str(exc) only, never a traceback."""
    text = str(exc).strip() or exc.__class__.__name__
    if len(text) > _ERROR_MESSAGE_MAX_CHARS:
        return text[:_ERROR_MESSAGE_MAX_CHARS] + "…"
    return text


def _warehouse_error_message(exc: Exception) -> str:
    """A user-safe message for a warehouse failure during a dry run.

    A failure to *reach* the warehouse and a failure to *run the query* are not
    the same class of thing and must not be reported the same way:

    * A ``WarehouseCapabilityError`` is a message tripl authored about a
      configuration the operator can act on ("PostgreSQL 13 is too old"). It holds
      no host, port or credential — surfaced verbatim (see ``core/adapters/errors``).
    * A connection / auth / timeout failure is a DRIVER string that routinely names
      the host, the port and the user. It is replaced with a generic sentence, the
      same rule ``datasource_service._friendly_test_error`` enforces; the full text
      stays in the server log.
    * Anything else is the ENGINE's own diagnosis of the user's SQL ("Unrecognized
      name: amont at [1:8]") — the whole reason to execute a dry run — and is
      surfaced trimmed. It names the user's query, not our infrastructure.
    """
    if isinstance(exc, WarehouseCapabilityError):
        return _trimmed_error(exc)
    lowered = str(exc).lower()
    if any(hint in lowered for hint in _TIMEOUT_HINTS):
        return "The data source did not respond in time."
    if any(hint in lowered for hint in _UNREACHABLE_HINTS):
        return "Could not reach the data source — check its host, port, and network."
    if any(hint in lowered for hint in _AUTH_HINTS):
        return "The data source rejected the credentials — check its connection settings."
    return _trimmed_error(exc)


def _error_response(message: str, *, columns: list[str] | None = None) -> MetricPreviewResponse:
    return MetricPreviewResponse(
        columns=columns or [],
        points=[],
        point_count=0,
        truncated=False,
        error=message,
    )


def _fact_error_response(
    message: str, *, columns: list[str] | None = None
) -> FactOperandPreviewResponse:
    return FactOperandPreviewResponse(columns=columns or [], row_count=0, error=message)


def _run_preview_query(
    ds: DataSource,
    sql: str,
    *,
    limit: int,
    time_column: str,
    time_from: datetime,
    time_to: datetime,
) -> tuple[list[str], list[tuple[object, ...]]]:
    """Open a sync adapter, run the wrapped SELECT, return (columns, rows).

    Mirrors ``datasource_service._run_adapter_test``: the adapter is built and
    closed per call, and the caller executes this via ``asyncio.to_thread`` so
    the sync warehouse driver never blocks the event loop. ``build_adapter``
    applies the data source's ``timeout_seconds`` to the connect/query budget.
    """
    from tripl.core.adapters.registry import build_adapter

    adapter = build_adapter(ds)
    try:
        return adapter.get_preview_rows(
            sql,
            limit=limit,
            time_column=time_column,
            time_from=time_from,
            time_to=time_to,
        )
    finally:
        with contextlib.suppress(Exception):
            adapter.close()


async def preview_sql_metric(
    session: AsyncSession, slug: str, data: MetricPreviewRequest
) -> MetricPreviewResponse:
    """Validate + execute a draft sql-metric SELECT and return bucketed points.

    The window is the last ``PREVIEW_WINDOW_BUCKETS`` buckets of the requested
    interval ending now, applied by the adapter's time-window wrapping (the
    same wrapping ``_collect_sql`` uses), with a hard ``PREVIEW_ROW_LIMIT`` row
    cap. Rows are floored to interval buckets exactly like a real collection
    (later rows for the same bucket overwrite earlier ones). Nothing is
    persisted and the full SQL is never logged here.
    """
    # Reuses the worker's bucket/value coercion so preview points match what a
    # collection would store. Imported lazily to keep the Celery worker stack
    # out of module import (mirrors metric_definition_service).
    from tripl.worker.tasks.metrics.metric_collect import (
        SQL_VALUE_COLUMN,
        _coerce_bucket,
        _coerce_value,
    )

    await get_project_id_by_slug(session, slug)  # 404 for an unknown project
    ds = await session.scalar(select(DataSource).where(DataSource.id == data.data_source_id))
    if ds is None:
        raise HTTPException(status_code=404, detail="Data source not found")

    value_column = data.value_column or SQL_VALUE_COLUMN
    try:
        validate_identifier(data.time_column)
        if data.value_column is not None:
            validate_identifier(data.value_column)
        safe_sql = validate_select_sql(
            data.sql, value_column=value_column, time_column=data.time_column
        )
        dialect = dialect_for_db_type(ds.db_type)
    except ValueError as exc:
        return _error_response(str(exc))

    # Dialect gate, AFTER the read-only gate and never instead of it. Free-text SQL
    # is explicitly dialect-specific: a query written against ClickHouse cannot run
    # on the BigQuery source the user just pointed it at, and without this the first
    # sign of that is a driver stack trace from inside a Celery worker — the query
    # having been saved and scheduled long before. Catching it here turns it into a
    # sentence naming the function and the form to use instead.
    mismatch = lint_dialect_sql(safe_sql, dialect)
    if mismatch is not None:
        return _error_response(mismatch)

    delta = get_interval(data.interval.value).delta
    time_to = datetime.now(UTC)
    time_from = time_to - PREVIEW_WINDOW_BUCKETS * delta

    try:
        columns, rows = await asyncio.to_thread(
            _run_preview_query,
            ds,
            safe_sql,
            limit=PREVIEW_ROW_LIMIT,
            time_column=data.time_column,
            time_from=time_from,
            time_to=time_to,
        )
    except Exception as exc:  # noqa: BLE001 - warehouse failures are user-facing
        logger.exception("Metric SQL preview failed for data source %s", ds.id)
        return _error_response(_warehouse_error_message(exc))

    index_by_name = {name: index for index, name in enumerate(columns)}
    missing = [column for column in (data.time_column, value_column) if column not in index_by_name]
    if missing:
        names = ", ".join(repr(column) for column in missing)
        return _error_response(
            f"Query result does not include the required column(s): {names}",
            columns=list(columns),
        )

    time_index = index_by_name[data.time_column]
    value_index = index_by_name[value_column]
    values: dict[datetime, float] = {}
    try:
        for row in rows:
            bucket = _coerce_bucket(row[time_index], delta)
            values[bucket] = _coerce_value(row[value_index])
    except (TypeError, ValueError) as exc:
        return _error_response(_trimmed_error(exc), columns=list(columns))

    points = [
        MetricPreviewPoint(bucket=bucket, value=value) for bucket, value in sorted(values.items())
    ]
    return MetricPreviewResponse(
        columns=list(columns),
        points=points,
        point_count=len(points),
        truncated=len(rows) >= PREVIEW_ROW_LIMIT,
        error=None,
    )


async def preview_fact_operand(
    session: AsyncSession, slug: str, data: FactOperand
) -> FactOperandPreviewResponse:
    """Compile a draft fact operand's row filter and EXECUTE it, persisting nothing.

    A ``fact`` metric's filters are compiled per dialect and validated at compile
    time, but until this existed nothing ever *ran* them: the first execution was
    inside a Celery worker, long after the user saved and walked away. This closes
    that — the same dry-run contract the ``sql`` kind already had.

    Divergence is designed out rather than tested for. The request body IS a
    :class:`FactOperand`, so ``to_config()`` produces the exact dict a save would
    persist; that dict is parsed by the worker's own ``_operand_from_config`` and
    compiled by the worker's own ``_resolve_fact_operand_query`` for the fact
    table's data-source dialect. The SQL previewed here is therefore the SQL the
    collection will run — not a re-implementation of it. The measure/distinct
    column is then checked against the columns the filtered query actually
    returned, exactly as ``_aggregate_fact_window`` does before aggregating.

    Read-only boundary: unchanged and un-weakened. Free-text filters clear
    ``validate_sql_fragment`` at the ``FactOperand`` schema boundary (no comments,
    no ``;``, no DDL/DML/UNION/SELECT/WITH), stored named filters are re-validated
    by the same gate when they are resolved, and structured conditions are compiled
    through ``quote_identifier`` / ``quote_sql_literal``. This function adds no SQL
    of its own and relaxes nothing: it can only execute a string the collector
    would have executed anyway.
    """
    # Imported lazily so the Celery worker stack stays out of module import (same
    # reason ``preview_sql_metric`` defers its import of the collector helpers).
    from tripl.worker.tasks._errors import ScanError
    from tripl.worker.tasks.metrics.metric_collect import (
        _fact_operand_measure,
        _operand_from_config,
        _resolve_fact_operand_query,
    )

    # Project-scoped: 404 for an unknown project or a fact table in another one.
    fact_table = await get_fact_table(session, slug, data.fact_table_id)
    if fact_table.data_source_id is None:
        return _fact_error_response(
            "This fact table has no data source bound; bind one before previewing filters."
        )
    ds = await session.scalar(select(DataSource).where(DataSource.id == fact_table.data_source_id))
    if ds is None:
        raise HTTPException(status_code=404, detail="Data source not found")

    try:
        dialect = dialect_for_db_type(ds.db_type)
        operand = _operand_from_config(data.to_config())
        base_query = _resolve_fact_operand_query(fact_table, operand, dialect=dialect)
    except (ScanError, ValueError) as exc:
        # Compile-time rejections (unknown named filter, unsupported operator,
        # unquotable value). tripl-authored messages — safe verbatim.
        return _fact_error_response(_trimmed_error(exc))

    time_to = datetime.now(UTC)
    time_from = time_to - FACT_PREVIEW_WINDOW
    try:
        columns, rows = await asyncio.to_thread(
            _run_preview_query,
            ds,
            base_query,
            limit=FACT_PREVIEW_ROW_LIMIT,
            time_column=fact_table.timestamp_column,
            time_from=time_from,
            time_to=time_to,
        )
    except Exception as exc:  # noqa: BLE001 - warehouse failures are user-facing
        logger.exception("Fact operand preview failed for fact table %s", fact_table.id)
        return _fact_error_response(_warehouse_error_message(exc))

    if requires_measure(operand.aggregation):
        measure = _fact_operand_measure(operand)
        if measure is None:
            return _fact_error_response(
                f"Aggregation {operand.aggregation.value!r} requires a "
                "measure column / distinct column.",
                columns=list(columns),
            )
        if not columns:
            # Mirrors the collector: an empty allowlist makes
            # ``validate_measure_column`` skip its membership check, so an empty
            # column list must fail loudly rather than silently pass.
            return _fact_error_response(
                "The filtered fact query returned no columns; the measure column "
                "cannot be validated.",
                columns=list(columns),
            )
        try:
            validate_measure_column(measure, set(columns))
        except ValueError as exc:
            return _fact_error_response(_trimmed_error(exc), columns=list(columns))

    return FactOperandPreviewResponse(columns=list(columns), row_count=len(rows), error=None)
