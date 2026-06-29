from __future__ import annotations

import re

from tripl.models.domain_enums import MetricAggregation

# Dialect-agnostic security validator for user-supplied measure expressions,
# columns, and sql-kind SELECTs used by ``fact_aggregation`` / ``sql`` metrics.
#
# Security model (matches the warehouse adapters): IDENTIFIER-ALLOWLIST +
# LITERAL-ESCAPING with NO bound parameters. This module never escapes literals
# itself; callers pass already-escaped identifiers built with the adapter's own
# quoting helper. It only validates raw identifiers against the allowlist and
# assembles the safe aggregate fragment from the constrained DSL.

# Mirrors the adapters' ``_IDENTIFIER_RE``: a leading letter/underscore followed
# by letters/digits/underscores and dots (for qualified names). This rejects
# whitespace, quotes, semicolons, parentheses, comment markers, and operators,
# so injection attempts never reach the SQL string.
_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")

# Aggregations that require a measure column. ``count`` is the only member that
# operates without one (it counts rows via ``count(*)``).
_MEASURE_REQUIRED: frozenset[MetricAggregation] = frozenset(
    {
        MetricAggregation.sum,
        MetricAggregation.avg,
        MetricAggregation.min,
        MetricAggregation.max,
        MetricAggregation.count_distinct,
    }
)

# Statement keywords that make a "read-only SELECT" claim false. Matched
# case-insensitively on word boundaries so an identifier suffix like
# ``updated_at`` does not trip ``update`` (and ``created_at`` does not trip
# ``create``). Kept deliberately broad: anything that writes, locks, changes
# schema, changes session state, or stacks a second query (``union``) is
# rejected. This set is shared by every SQL-text validator below.
_FORBIDDEN_SQL_KEYWORDS: tuple[str, ...] = (
    "union",
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "create",
    "truncate",
    "grant",
    "revoke",
    "attach",
    "detach",
    "copy",
    "call",
    "exec",
    "execute",
    "use",
    "into",
    "vacuum",
    "system",
)
_FORBIDDEN_SQL_RE = re.compile(
    r"\b(" + "|".join(_FORBIDDEN_SQL_KEYWORDS) + r")\b",
    re.IGNORECASE,
)

# Comment markers that can hide trailing injection from a naive scan.
_COMMENT_MARKERS: tuple[str, ...] = ("--", "/*", "*/", "#")

_LEADING_SELECT_RE = re.compile(r"^\s*select\b", re.IGNORECASE)
_FROM_RE = re.compile(r"\bfrom\b", re.IGNORECASE)


def _clause_from_index(sql: str) -> int | None:
    """Index of the FROM *clause* keyword (paren depth 0), or ``None``.

    A ``from`` token nested inside function arguments — ``EXTRACT(EPOCH FROM
    ts)``, ``TRIM(LEADING x FROM col)``, ``SUBSTRING(col FROM n)`` — sits at a
    non-zero parenthesis depth and is therefore *not* the clause boundary. Only
    the first ``from`` at depth 0 separates the projection from the rest of the
    statement. Parentheses inside string literals are not specially handled
    (accepted limitation for v1).
    """
    for match in _FROM_RE.finditer(sql):
        depth = sql.count("(", 0, match.start()) - sql.count(")", 0, match.start())
        if depth == 0:
            return match.start()
    return None


def validate_identifier(name: str) -> str:
    """Validate a raw identifier against the allowlist regex and return it.

    Accepts a plain identifier or a qualified ``schema.table`` dot form
    (``^[a-zA-Z_][a-zA-Z0-9_.]*$``). Rejects whitespace, quotes, semicolons,
    parentheses, comment markers, operators, and a leading digit, so an injection
    attempt never reaches the SQL string. Reuses the module-level identifier
    regex shared with ``validate_measure_column``. Raises ``ValueError`` (English)
    on any violation.
    """
    if not _IDENTIFIER_RE.match(name):
        msg = f"Invalid identifier: {name!r}"
        raise ValueError(msg)
    return name


def validate_sql_fragment(text: str) -> str:
    """Validate a raw WHERE-clause fragment (e.g. a metric ``filter_sql``).

    Intended for boolean filter expressions, not full statements. Rejects comment
    markers (``--``/``/*``/``*/``/``#``), an embedded ``;``, and any forbidden
    DDL/DML/session/``UNION`` keyword (matched on word boundaries,
    case-insensitively). Returns ``text`` unchanged. Legitimate filters such as
    ``status IN ('a','b') AND created_at > '2026-01-01'`` pass (``created_at``
    does not trip ``create``); probes like ``1=1 UNION SELECT ...`` or
    ``x; DROP ...`` are rejected. Raises ``ValueError`` (English) on violation.
    """
    for marker in _COMMENT_MARKERS:
        if marker in text:
            msg = f"Filter must not contain comments or comment markers ({marker!r})"
            raise ValueError(msg)
    if ";" in text:
        msg = "Filter must not contain ';' separators"
        raise ValueError(msg)
    forbidden = _FORBIDDEN_SQL_RE.search(text)
    if forbidden is not None:
        msg = f"Filter must be read-only; disallowed keyword: {forbidden.group(1).upper()}"
        raise ValueError(msg)
    return text


def coerce_aggregation(agg_fn: MetricAggregation | str) -> MetricAggregation:
    """Constrain an aggregation to the ``MetricAggregation`` DSL.

    Accepts an enum member or its string value and returns the canonical
    ``MetricAggregation``. Raises ``ValueError`` for anything outside the
    DSL (count/sum/avg/min/max/count_distinct).
    """
    if isinstance(agg_fn, MetricAggregation):
        return agg_fn
    try:
        return MetricAggregation(agg_fn)
    except ValueError as exc:
        msg = f"Unsupported aggregation function: {agg_fn!r}"
        raise ValueError(msg) from exc


def validate_measure_column(column: str, allowed_columns: set[str]) -> str:
    """Validate a measure / distinct column against the query allowlist.

    ``allowed_columns`` is the set of column names returned by the adapter's
    ``get_columns`` for the metric's base query. The check mirrors the adapters'
    ``_validate_column``: the name must be a plain identifier and, when the
    allowlist is known (non-empty), must be a member of it. Returns the
    validated raw column name (unescaped) so the caller can quote it with its
    own dialect helper.
    """
    if not _IDENTIFIER_RE.match(column):
        msg = f"Invalid measure column: {column!r}"
        raise ValueError(msg)
    if allowed_columns and column not in allowed_columns:
        msg = f"Measure column {column!r} not found in query result"
        raise ValueError(msg)
    return column


def build_aggregate_sql(
    agg_fn: MetricAggregation | str,
    measure_sql: str | None = None,
) -> str:
    """Build a SAFE aggregate SQL fragment from the constrained DSL.

    ``measure_sql`` must be an already-validated, already-escaped identifier
    (e.g. the adapter's quoted column). ``count`` ignores the measure and emits
    ``count(*)``; every other aggregation requires a non-empty ``measure_sql``.
    The returned fragment has no alias; callers append ``AS _value``.

    Output forms (lowercase function names, valid across ClickHouse / Postgres /
    BigQuery): ``count(*)``, ``sum(<m>)``, ``avg(<m>)``, ``min(<m>)``,
    ``max(<m>)``, ``count(DISTINCT <m>)``.
    """
    agg = coerce_aggregation(agg_fn)
    if agg is MetricAggregation.count:
        return "count(*)"
    if not measure_sql:
        msg = f"Aggregation {agg.value!r} requires a measure column"
        raise ValueError(msg)
    if agg is MetricAggregation.count_distinct:
        return f"count(DISTINCT {measure_sql})"
    # sum/avg/min/max map their enum value directly onto the SQL function name.
    return f"{agg.value}({measure_sql})"


def requires_measure(agg_fn: MetricAggregation | str) -> bool:
    """Whether the aggregation needs a measure column (everything but count)."""
    return coerce_aggregation(agg_fn) in _MEASURE_REQUIRED


def validate_select_sql_safety(sql: str) -> str:
    """Structural-safety subset of ``validate_select_sql`` (no column check).

    Used at schema-creation time, before the value/time column names are bound,
    so it asserts only that the statement is a single, read-only ``SELECT``:

    * a single leading ``SELECT`` (CTEs — a leading ``WITH`` — are rejected for
      v1; this is an accepted limitation),
    * at most one optional trailing ``;`` and no other ``;`` (no stacked /
      injected second statements),
    * no comment markers (``--``/``#``/``/* */``),
    * no DDL/DML/session keyword and no ``UNION`` (INSERT/UPDATE/DELETE/DROP/
      ALTER/CREATE/TRUNCATE/GRANT/COPY/UNION/...).

    Returns the trimmed statement with any single trailing ``;`` stripped. Raises
    ``ValueError`` (English) on any violation.
    """
    if not sql or not sql.strip():
        msg = "Metric SQL must be a non-empty SELECT statement"
        raise ValueError(msg)

    stripped = sql.strip()

    for marker in _COMMENT_MARKERS:
        if marker in stripped:
            msg = f"Metric SQL must not contain comments or comment markers ({marker!r})"
            raise ValueError(msg)

    # Allow exactly one optional trailing semicolon; anything else is a stacked
    # statement (or an injected second statement) and is rejected.
    without_trailing = stripped[:-1].rstrip() if stripped.endswith(";") else stripped
    if ";" in without_trailing:
        msg = "Metric SQL must be a single statement (no ';' separators)"
        raise ValueError(msg)

    if not _LEADING_SELECT_RE.match(without_trailing):
        msg = "Metric SQL must be a single read-only SELECT statement"
        raise ValueError(msg)

    forbidden = _FORBIDDEN_SQL_RE.search(without_trailing)
    if forbidden is not None:
        msg = f"Metric SQL must be read-only; disallowed keyword: {forbidden.group(1).upper()}"
        raise ValueError(msg)

    return without_trailing


def validate_select_sql(metric_sql: str, *, value_column: str, time_column: str) -> str:
    """Validate a user-authored ``sql``-kind SELECT and return it trimmed.

    A valid statement passes ``validate_select_sql_safety`` (single read-only
    ``SELECT``, no stacked statements, no comments, no DDL/DML/UNION; CTEs are an
    accepted v1 limitation) **and** projects both the value column and the time
    column. The projection is the slice before the FROM *clause*: FROM detection
    is parenthesis-depth-aware, so a ``from`` nested in function arguments
    (``EXTRACT(EPOCH FROM ts)``, ``SUBSTRING(col FROM n)``) is not mistaken for
    the clause boundary.

    Numeric-ness of the value column is enforced downstream at execution time;
    here we only require that both columns are projected. Raises ``ValueError``
    (English) on any violation.
    """
    without_trailing = validate_select_sql_safety(metric_sql)

    from_index = _clause_from_index(without_trailing)
    projection = without_trailing if from_index is None else without_trailing[:from_index]

    for column, label in ((value_column, "value"), (time_column, "time")):
        if not re.search(rf"\b{re.escape(column)}\b", projection, re.IGNORECASE):
            msg = f"Metric SQL must project the {label} column {column!r}"
            raise ValueError(msg)

    return without_trailing
