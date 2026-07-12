"""Stateless dry-run preview for ``sql``-kind catalog metrics.

Runs a user-authored SELECT against a data source with the SAME safety gate
(``validate_select_sql``) and time-window wrapping (``get_preview_rows``) the
worker's ``_collect_sql`` uses, but persists nothing. Expected user mistakes —
bad SQL, missing projected columns, warehouse errors — come back as a 200
payload with ``error`` set so the SQL editor can render them inline; only
auth, unknown project, and unknown data source use 4xx.
"""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.adapters.measure_validator import (
    dialect_for_db_type,
    lint_dialect_sql,
    validate_identifier,
    validate_select_sql,
)
from tripl.core.intervals import get_interval
from tripl.models.data_source import DataSource
from tripl.schemas.metric_definition import (
    MetricPreviewPoint,
    MetricPreviewRequest,
    MetricPreviewResponse,
)
from tripl.services.project_lookup import get_project_id_by_slug

logger = logging.getLogger(__name__)

# Preview window: the last N interval buckets ending now. Small enough to stay
# interactive, large enough to show the series shape.
PREVIEW_WINDOW_BUCKETS = 50

# Hard row cap (LIMIT) on the wrapped query; the response flags truncation.
PREVIEW_ROW_LIMIT = 200

# Warehouse error strings are trimmed to this many characters so a driver's
# kilobyte-long dump never reaches the client (full context stays in logs).
_ERROR_MESSAGE_MAX_CHARS = 500


def _trimmed_error(exc: Exception) -> str:
    """A user-safe, bounded error message: str(exc) only, never a traceback."""
    text = str(exc).strip() or exc.__class__.__name__
    if len(text) > _ERROR_MESSAGE_MAX_CHARS:
        return text[:_ERROR_MESSAGE_MAX_CHARS] + "…"
    return text


def _error_response(message: str, *, columns: list[str] | None = None) -> MetricPreviewResponse:
    return MetricPreviewResponse(
        columns=columns or [],
        points=[],
        point_count=0,
        truncated=False,
        error=message,
    )


def _run_preview_query(
    ds: DataSource,
    sql: str,
    *,
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
            limit=PREVIEW_ROW_LIMIT,
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
            time_column=data.time_column,
            time_from=time_from,
            time_to=time_to,
        )
    except Exception as exc:  # noqa: BLE001 - warehouse failures are user-facing
        logger.exception("Metric SQL preview failed for data source %s", ds.id)
        return _error_response(_trimmed_error(exc))

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
