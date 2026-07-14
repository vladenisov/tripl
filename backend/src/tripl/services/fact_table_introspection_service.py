"""Introspect a fact-table SQL: bucketed columns, identifier candidates, samples.

This powers the FactTable create/edit "Preview columns" surface. Given a
project, a data source, and a read-only ``SELECT``, it opens a warehouse
adapter, asks it for the query's output columns (warehouse type names) and a
bounded set of preview rows, then returns:

* ``columns`` with each warehouse type bucketed to one of
  ``number`` / ``string`` / ``bool`` / ``timestamp``,
* ``identifier_candidates`` (string-typed columns whose name or declared
  warehouse type carries an identifier signal — see
  :func:`is_identifier_column` — excluding the timestamp column), and
* ``sample_rows`` coerced to JSON-safe scalars.

Scope: a data source is global in this schema; it "belongs to" a project when
the project has at least one ``ScanConfig`` bound to it. The introspection
refuses any data source the project is not already using.

Security: the SQL is re-validated as a safe read-only ``SELECT`` before any
warehouse call (defense in depth — the request schemas validate it too), and the
adapter runs it as a bounded, read-only subquery with its own identifier-allowlist
/ literal-escaping. This module adds no other SQL string handling; beyond that it
only buckets type names and coerces scalars.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.adapters.base import BaseAdapter, ColumnInfo
from tripl.core.adapters.measure_validator import validate_select_sql_safety
from tripl.models.data_source import DataSource
from tripl.models.scan_config import ScanConfig

logger = logging.getLogger(__name__)

# Default preview size for the create/edit UI. Bounded so a preview never pulls
# more than a handful of rows back from the warehouse.
_DEFAULT_SAMPLE_LIMIT = 20

# User-safe message for any adapter failure (bad SQL, connection, timeout). The
# underlying exception is logged server-side; its text is never surfaced so a
# warehouse error string cannot leak host/credentials into an API response.
_PREVIEW_FAILED_MESSAGE = (
    "Could not read columns from the data source. "
    "Check the SQL statement and the data source connection."
)

# --- Bucketed column types (the only values a FactTable column ``type`` holds) ---
_NUMBER = "number"
_STRING = "string"
_BOOL = "bool"
_TIMESTAMP = "timestamp"

# Exact (post-normalization) tokens that map to ``bool``. Checked before the
# numeric prefixes so ClickHouse ``Bool`` / Postgres ``boolean`` never fall
# through to ``number``.
_BOOL_TYPES: frozenset[str] = frozenset({"bool", "boolean"})

# Leading-token prefixes that map to ``timestamp`` across dialects:
# ClickHouse ``DateTime``/``DateTime64``/``Date``/``Date32``; Postgres
# ``timestamp``/``timestamptz``/``date``/``time``; BigQuery
# ``TIMESTAMP``/``DATETIME``/``DATE``/``TIME``.
_TIMESTAMP_PREFIXES: tuple[str, ...] = ("datetime", "timestamp", "date", "time")

# Leading-token prefixes that map to ``number`` across dialects: ClickHouse
# ``Int*``/``UInt*``/``Float*``/``Decimal``; Postgres ``int*``/``smallint``/
# ``bigint``/``numeric``/``decimal``/``real``/``double``/``money``; BigQuery
# ``INT64``/``FLOAT64``/``NUMERIC``/``BIGNUMERIC``.
_NUMBER_PREFIXES: tuple[str, ...] = (
    "int",
    "uint",
    "float",
    "double",
    "real",
    "decimal",
    "numeric",
    "bignumeric",
    "smallint",
    "bigint",
    "money",
)

# Exact (post-normalization) tokens that share a numeric prefix but are NOT
# numbers. Checked before the numeric-prefix scan so Postgres ``interval`` (a
# time-span type whose leading token matches the ``int`` prefix) buckets to
# ``string`` rather than being offered as a numeric measure.
_NON_NUMBER_EXACT: frozenset[str] = frozenset({"interval"})

# ClickHouse type wrappers stripped before bucketing the inner type.
_TYPE_WRAPPERS: tuple[str, ...] = ("nullable(", "lowcardinality(")

# --- Identifier-candidate detection -----------------------------------------
# A column is only suggested as an identifier when its NAME (or declared
# warehouse type) carries a standard identifier signal. Being string-typed is
# necessary (count_distinct contract) but no longer sufficient: with the old
# "every string column" rule, ordinary dimensions like ``country`` or
# ``platform`` — and every other string column — were suggested and then
# persisted wholesale by the edit UI's pre-selection.
#
# Bare names that are identifiers on their own, matched case-insensitively.
_IDENTIFIER_EXACT_NAMES: frozenset[str] = frozenset({"id", "uuid", "guid"})
# snake_case suffixes, matched case-insensitively (``user_id``, ``DEVICE_UUID``).
_IDENTIFIER_SNAKE_SUFFIXES: tuple[str, ...] = ("_id", "_uuid", "_guid")
# camelCase suffixes (``deviceId``, ``deviceID``, ``sessionUuid``). The
# case-sensitive lower/digit boundary before the suffix is what keeps plain
# words that merely END in "id" — ``paid``, ``valid``, ``android`` — out.
_IDENTIFIER_CAMEL_SUFFIX_RE = re.compile(r"[a-z0-9](?:Id|ID|Uuid|UUID|Guid|GUID)$")
# Declared warehouse types that mark a column as an identifier regardless of
# its name (a UUID-typed column is an identifier by construction). Compared
# against the unwrapped leading type token, lowercased.
_IDENTIFIER_TYPE_TOKENS: frozenset[str] = frozenset({"uuid", "uniqueidentifier"})


def is_identifier_column(name: str, type_name: str = "") -> bool:
    """Whether a column looks like an identifier (by name, or by declared type).

    Name signals: exact ``id``/``uuid``/``guid`` (any case), a ``_id``/``_uuid``/
    ``_guid`` snake_case suffix (any case), or a camelCase ``Id``/``ID``/
    ``Uuid``/... suffix preceded by a lowercase letter or digit. Type signal: a
    declared ``UUID`` warehouse type. Deliberately conservative — words that
    merely end in "id" (``paid``, ``valid``, ``android``) do not match, and no
    data is scanned.
    """
    lowered = name.strip().lower()
    if lowered in _IDENTIFIER_EXACT_NAMES:
        return True
    if lowered.endswith(_IDENTIFIER_SNAKE_SUFFIXES):
        return True
    if _IDENTIFIER_CAMEL_SUFFIX_RE.search(name.strip()):
        return True
    if not type_name:
        return False
    return _leading_token(_unwrap_type(type_name.strip().lower())) in _IDENTIFIER_TYPE_TOKENS


class FactTableIntrospectionError(ValueError):
    """A fact-table SQL could not be introspected.

    Carries a user-safe message (no credentials, no stack detail). Slice .3 maps
    this to an HTTP 400/404 at the router boundary.
    """


@dataclass(frozen=True)
class FactTableColumn:
    name: str
    # Bucketed type: one of "number" | "string" | "bool" | "timestamp".
    type: str
    # Exact adapter type used by type-directed SQL builders (for example,
    # BigQuery TIMESTAMP vs DATETIME vs DATE).
    native_type: str | None = None


@dataclass(frozen=True)
class FactTableIntrospection:
    columns: list[FactTableColumn]
    # String-typed columns with an identifier signal in their name or declared
    # type (see ``is_identifier_column``), excluding the timestamp column.
    # Order mirrors the projected column order for determinism.
    identifier_candidates: list[str]
    # Up to ``sample_limit`` preview rows with JSON-safe scalar values.
    sample_rows: list[dict[str, object]]


def _unwrap_type(normalized: str) -> str:
    """Strip ClickHouse ``Nullable(...)`` / ``LowCardinality(...)`` wrappers.

    Works on an already lowercased string and unwraps in any nesting order
    (``nullable(lowcardinality(string))`` and the reverse) until stable.
    """
    changed = True
    while changed:
        changed = False
        for wrapper in _TYPE_WRAPPERS:
            if normalized.startswith(wrapper) and normalized.endswith(")"):
                normalized = normalized[len(wrapper) : -1].strip()
                changed = True
    return normalized


def _leading_token(normalized: str) -> str:
    """Leading identifier token of a type name (``decimal(18,2)`` -> ``decimal``)."""
    token: list[str] = []
    for char in normalized:
        if char.isalnum() or char == "_":
            token.append(char)
        else:
            break
    return "".join(token)


def bucket_warehouse_type(type_name: str) -> str:
    """Map a warehouse type name to a bucketed FactTable column type.

    Returns one of ``"number"``, ``"string"``, ``"bool"``, ``"timestamp"``.
    Handles ClickHouse (``Int64``, ``Float64``, ``DateTime64(3)``, ``Bool``,
    ``Nullable(...)``, ``LowCardinality(...)``), Postgres (``integer``,
    ``double precision``, ``timestamp with time zone``, ``boolean``), and
    BigQuery (``INT64``, ``FLOAT64``, ``TIMESTAMP``, ``BOOL``) spellings.
    Unknown or complex types (``Array(...)``, ``JSON``, ``UUID``) default to
    ``"string"`` so the column stays selectable but is never mistaken for a
    numeric measure.
    """
    if not type_name:
        return _STRING
    token = _leading_token(_unwrap_type(type_name.strip().lower()))
    if token in _BOOL_TYPES:
        return _BOOL
    if token.startswith(_TIMESTAMP_PREFIXES):
        return _TIMESTAMP
    if token in _NON_NUMBER_EXACT:
        return _STRING
    if token.startswith(_NUMBER_PREFIXES):
        return _NUMBER
    return _STRING


def _json_safe(value: object) -> object:
    """Coerce a sampled warehouse value into a JSON-safe scalar.

    ``datetime``/``date`` -> ISO 8601 string, ``Decimal`` -> ``float``,
    ``bytes``-like -> ``repr`` string. Native JSON scalars pass through, except
    non-finite floats (``NaN``/``±Infinity``) which become ``None`` to keep the
    body valid RFC 7159 JSON. Anything else falls back to ``str`` so the preview
    never carries a non-serializable object.
    """
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        # NaN / ±Infinity are valid Python floats but invalid JSON (RFC 7159);
        # coerce them to null so the preview body stays strictly parseable.
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return float(value)
    # ``datetime`` is a subclass of ``date``; both expose ``isoformat``.
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return repr(bytes(value))
    return str(value)


def _rows_to_dicts(
    column_names: list[str],
    rows: list[tuple[object, ...]],
    sample_limit: int,
) -> list[dict[str, object]]:
    """Zip ``(names, rows)`` into JSON-safe dicts, bounded by ``sample_limit``."""
    if sample_limit <= 0:
        return []
    return [
        {name: _json_safe(value) for name, value in zip(column_names, row, strict=False)}
        for row in rows[:sample_limit]
    ]


async def _load_project_data_source(
    session: AsyncSession,
    project_id: uuid.UUID,
    data_source_id: uuid.UUID | None,
) -> DataSource:
    """Load the data source and assert the project is allowed to use it.

    A data source is global; it "belongs to" a project when the project has at
    least one ``ScanConfig`` bound to it. Raises ``FactTableIntrospectionError``
    when no data source is given, the row is missing, or it is not in scope.
    """
    if data_source_id is None:
        msg = "A data source is required to preview fact-table columns."
        raise FactTableIntrospectionError(msg)
    # Use one message for both "row missing" and "row exists but out of scope":
    # distinct messages would let a project member probe arbitrary UUIDs and
    # distinguish non-existent ids from other projects' data sources (enumeration).
    not_available_msg = "Data source is not available in this project."
    data_source = await session.get(DataSource, data_source_id)
    if data_source is None:
        raise FactTableIntrospectionError(not_available_msg)
    in_project = await session.scalar(
        select(ScanConfig.id)
        .where(
            ScanConfig.data_source_id == data_source_id,
            ScanConfig.project_id == project_id,
        )
        .limit(1)
    )
    if in_project is None:
        raise FactTableIntrospectionError(not_available_msg)
    return data_source


def _close_adapter(adapter: BaseAdapter) -> None:
    """Close the adapter, swallowing a close failure so it can't mask results."""
    try:
        adapter.close()
    except Exception as exc:  # noqa: BLE001 - close failure must not mask the result
        logger.debug("adapter.close() failed after fact-table introspection: %s", exc)


def _run_introspection(
    data_source: DataSource,
    sql: str,
    sample_limit: int,
) -> tuple[list[ColumnInfo], list[dict[str, object]]]:
    """Open a sync adapter, read columns + preview rows, always close.

    Wraps every adapter failure (build, query, connection) in a
    ``FactTableIntrospectionError`` carrying only the user-safe message; the
    original exception is logged server-side and chained for diagnostics.
    """
    from tripl.core.adapters.registry import build_adapter

    try:
        adapter = build_adapter(data_source)
    except Exception as exc:
        # Log only the exception class at WARNING: driver connection errors can
        # embed host/username (and the constructor receives the decrypted
        # password), which must not flow to log aggregation. Full detail stays
        # at DEBUG for on-call diagnostics.
        logger.warning(
            "Failed to build adapter for fact-table introspection: %s",
            type(exc).__name__,
        )
        logger.debug("Adapter build failure detail", exc_info=True)
        raise FactTableIntrospectionError(_PREVIEW_FAILED_MESSAGE) from exc

    try:
        columns = adapter.get_columns(sql)
        column_names, rows = adapter.get_preview_rows(sql, limit=sample_limit)
    except Exception as exc:
        logger.warning("Fact-table introspection query failed: %s", type(exc).__name__)
        logger.debug("Introspection query failure detail", exc_info=True)
        raise FactTableIntrospectionError(_PREVIEW_FAILED_MESSAGE) from exc
    finally:
        _close_adapter(adapter)

    return columns, _rows_to_dicts(column_names, rows, sample_limit)


async def introspect_fact_table(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    data_source_id: uuid.UUID | None,
    sql: str,
    timestamp_column: str | None = None,
    sample_limit: int = _DEFAULT_SAMPLE_LIMIT,
) -> FactTableIntrospection:
    """Introspect a fact-table SQL and return columns, identifiers, and samples.

    Loads and scope-checks the data source, then runs the adapter on a worker
    thread (the adapters are synchronous). Each warehouse column type is bucketed
    via :func:`bucket_warehouse_type`; ``identifier_candidates`` are the
    string-typed columns that also pass :func:`is_identifier_column` (id-like
    name or UUID-declared type), excluding ``timestamp_column``, in projection
    order.

    Raises ``FactTableIntrospectionError`` when the data source is missing/out of
    scope, the SQL is not a safe read-only ``SELECT``, or the adapter cannot read
    the query.
    """
    # Defense in depth: the request schemas already gate ``sql`` via the same
    # validator, but re-check here so any direct (non-HTTP) caller cannot reach
    # the adapter with unsafe SQL.
    try:
        sql = validate_select_sql_safety(sql)
    except ValueError as exc:
        raise FactTableIntrospectionError(str(exc)) from exc
    data_source = await _load_project_data_source(session, project_id, data_source_id)
    columns, sample_rows = await asyncio.to_thread(
        _run_introspection, data_source, sql, sample_limit
    )

    bucketed = [
        FactTableColumn(
            name=column.name,
            type=bucket_warehouse_type(column.type_name),
            native_type=column.type_name,
        )
        for column in columns
    ]
    identifier_candidates = [
        raw.name
        for raw, column in zip(columns, bucketed, strict=True)
        if column.type == _STRING
        and column.name != timestamp_column
        and is_identifier_column(raw.name, raw.type_name)
    ]
    return FactTableIntrospection(
        columns=bucketed,
        identifier_candidates=identifier_candidates,
        sample_rows=sample_rows,
    )
