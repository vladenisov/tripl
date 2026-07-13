from __future__ import annotations

import math
import re
from collections.abc import Mapping
from datetime import datetime
from enum import StrEnum

from tripl.core.bucketing import format_utc_literal, to_utc
from tripl.core.warehouse_types import TimeKind, classify_time
from tripl.models.domain_enums import MetricAggregation

# Security validator for user-supplied measure expressions, columns, and sql-kind
# SELECTs used by ``fact`` / ``sql`` metrics, plus the DIALECT-AWARE rendering
# layer the structured (visual) filter compiler builds its SQL with.
#
# Security model (matches the warehouse adapters): IDENTIFIER-ALLOWLIST +
# LITERAL-ESCAPING with NO bound parameters. It validates raw identifiers against
# the allowlist and exposes the literal-quoting helpers for constrained DSLs that
# compile user-entered values into warehouse SQL.
#
# The read-only gate (``validate_select_sql``/``validate_select_sql_safety``/
# ``validate_sql_fragment``) is deliberately DIALECT-AGNOSTIC and is not relaxed
# per dialect: every statement/fragment must clear the same single-read-only-SELECT
# rules on every warehouse. ``lint_dialect_sql`` below only ever *adds* a rejection
# on top of that gate — it can never admit SQL the gate rejected.

# Mirrors the adapters' ``_IDENTIFIER_RE``: a leading letter/underscore followed
# by letters/digits/underscores and dots (for qualified names). This rejects
# whitespace, quotes, semicolons, parentheses, comment markers, and operators,
# so injection attempts never reach the SQL string.
_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")
_NUMERIC_LITERAL_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")

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

# Fragment-only forbidden set: everything ``validate_select_sql_safety`` rejects
# PLUS ``select`` and ``with``. A stored row filter is a boolean WHERE expression
# that must never embed a query, so a correlated subquery (``user_id IN (SELECT
# ...)``) or a CTE (``WITH ...``) is rejected. Same word-boundary construction as
# ``_FORBIDDEN_SQL_RE``, so identifiers like ``selected_count`` / ``is_selected``
# / ``created_with`` do not trip it.
_FORBIDDEN_FRAGMENT_KEYWORDS: tuple[str, ...] = (*_FORBIDDEN_SQL_KEYWORDS, "select", "with")
_FORBIDDEN_FRAGMENT_RE = re.compile(
    r"\b(" + "|".join(_FORBIDDEN_FRAGMENT_KEYWORDS) + r")\b",
    re.IGNORECASE,
)

# Comment markers that can hide trailing injection from a naive scan.
_COMMENT_MARKERS: tuple[str, ...] = ("--", "/*", "*/", "#")

_FROM_RE = re.compile(r"\bfrom\b", re.IGNORECASE)


class SqlDialect(StrEnum):
    """The warehouse SQL dialect a fragment/statement is compiled for."""

    clickhouse = "clickhouse"
    postgres = "postgres"
    bigquery = "bigquery"


#: ``DataSource.db_type`` -> dialect. The synthetic demo warehouse mimics ClickHouse
#: semantics (the frontend's ``sql-dialects.ts`` maps it the same way), so it compiles
#: as ClickHouse rather than getting a fourth spelling of every rule.
_DB_TYPE_DIALECT: dict[str, SqlDialect] = {
    "clickhouse": SqlDialect.clickhouse,
    "postgres": SqlDialect.postgres,
    "bigquery": SqlDialect.bigquery,
    "synthetic": SqlDialect.clickhouse,
}

#: ClickHouse and BigQuery back-tick identifiers; PostgreSQL double-quotes them.
_IDENTIFIER_QUOTE: dict[SqlDialect, str] = {
    SqlDialect.clickhouse: "`",
    SqlDialect.bigquery: "`",
    SqlDialect.postgres: '"',
}

#: A value must LOOK like a date/timestamp before we try to parse it as one, so a
#: plain string such as ``2026`` or ``12-34`` is never silently retyped.
_TIMESTAMP_TEXT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T].*)?$")

# BigQuery literal renderings (mirrors ``bigquery._DATETIME_LITERAL_FMT`` /
# ``_DATE_LITERAL_FMT``): DATETIME is a zone-less wall clock and REJECTS an offset.
_BQ_DATETIME_LITERAL_FMT = "%Y-%m-%d %H:%M:%S.%f"
_BQ_DATE_LITERAL_FMT = "%Y-%m-%d"

# `date_trunc(` followed by a STRING first argument. That is the ClickHouse/Postgres
# spelling; GoogleSQL's DATE_TRUNC takes (date_expr, date_part) and answers this form
# with "A valid date part name is required but found <column>" (verified on ZetaSQL).
_DATE_TRUNC_STRING_FIRST_RE = re.compile(r"\bdate_trunc\s*\(\s*['\"]", re.IGNORECASE)
_BACKTICK_RE = re.compile(r"`")


def _fn_re(name: str) -> re.Pattern[str]:
    """A call to ``name(`` — matched case-insensitively (PG and BigQuery both fold)."""
    return re.compile(rf"\b{re.escape(name)}\s*\(", re.IGNORECASE)


_CLICKHOUSE_BUCKET_HINT = (
    "Use toStartOfInterval(<time column>, INTERVAL 1 DAY, 'UTC') for a ClickHouse source."
)
_POSTGRES_BUCKET_HINT = (
    "Use date_bin(INTERVAL '1 day', <time column>, TIMESTAMPTZ '1970-01-01 00:00:00+00:00') "
    "for a PostgreSQL source."
)
_BIGQUERY_BUCKET_HINT = "Use TIMESTAMP_TRUNC(<time column>, DAY, 'UTC') for a BigQuery source."

#: Per-dialect "this cannot run here" rules, each verified against a live engine so a
#: valid query is never flagged. Ordered most-specific first.
_DIALECT_RULES: dict[SqlDialect, tuple[tuple[re.Pattern[str], str], ...]] = {
    SqlDialect.bigquery: (
        (
            _DATE_TRUNC_STRING_FIRST_RE,
            "BigQuery (GoogleSQL) has no date_trunc('<part>', <timestamp>): its DATE_TRUNC "
            f"takes (date_expr, date_part), not a leading string. {_BIGQUERY_BUCKET_HINT}",
        ),
        (
            _fn_re("toStartOfInterval"),
            "toStartOfInterval is a ClickHouse function and does not exist on BigQuery. "
            f"{_BIGQUERY_BUCKET_HINT}",
        ),
        (
            _fn_re("date_bin"),
            "date_bin is a PostgreSQL function and does not exist on BigQuery. "
            f"{_BIGQUERY_BUCKET_HINT}",
        ),
        (
            _fn_re("parseDateTime64BestEffort"),
            "parseDateTime64BestEffort is a ClickHouse function and does not exist on "
            "BigQuery. Use a typed literal such as TIMESTAMP '2026-01-01 00:00:00+00:00'.",
        ),
    ),
    SqlDialect.postgres: (
        (
            _fn_re("TIMESTAMP_TRUNC"),
            "TIMESTAMP_TRUNC is a BigQuery function and does not exist on PostgreSQL. "
            f"{_POSTGRES_BUCKET_HINT}",
        ),
        (
            _fn_re("TIMESTAMP_BUCKET"),
            "TIMESTAMP_BUCKET is a BigQuery function and does not exist on PostgreSQL. "
            f"{_POSTGRES_BUCKET_HINT}",
        ),
        (
            _fn_re("toStartOfInterval"),
            "toStartOfInterval is a ClickHouse function and does not exist on PostgreSQL. "
            f"{_POSTGRES_BUCKET_HINT}",
        ),
        (
            _fn_re("countIf"),
            "countIf is a ClickHouse function and does not exist on PostgreSQL. Use "
            "count(*) FILTER (WHERE <condition>).",
        ),
        (
            _fn_re("parseDateTime64BestEffort"),
            "parseDateTime64BestEffort is a ClickHouse function and does not exist on "
            "PostgreSQL. Use a typed literal such as TIMESTAMPTZ "
            "'2026-01-01 00:00:00+00:00'.",
        ),
        (
            _BACKTICK_RE,
            'PostgreSQL does not accept back-quoted identifiers. Use double quotes: "my column".',
        ),
    ),
    SqlDialect.clickhouse: (
        (
            _fn_re("TIMESTAMP_TRUNC"),
            "TIMESTAMP_TRUNC is a BigQuery function and does not exist on ClickHouse. "
            f"{_CLICKHOUSE_BUCKET_HINT}",
        ),
        (
            _fn_re("TIMESTAMP_BUCKET"),
            "TIMESTAMP_BUCKET is a BigQuery function and does not exist on ClickHouse. "
            f"{_CLICKHOUSE_BUCKET_HINT}",
        ),
        (
            _fn_re("date_bin"),
            "date_bin is a PostgreSQL function and does not exist on ClickHouse. "
            f"{_CLICKHOUSE_BUCKET_HINT}",
        ),
    ),
}


def dialect_for_db_type(db_type: str) -> SqlDialect:
    """Map a ``DataSource.db_type`` onto the dialect its SQL must be compiled for."""
    dialect = _DB_TYPE_DIALECT.get(db_type)
    if dialect is None:
        msg = f"Unsupported warehouse db_type: {db_type!r}"
        raise ValueError(msg)
    return dialect


def _is_word_char(char: str) -> bool:
    return char.isalnum() or char == "_"


def _keyword_at(sql: str, index: int, keyword: str) -> bool:
    """Whether ``keyword`` starts at ``index`` with SQL-ish word boundaries."""
    end = index + len(keyword)
    if sql[index:end].lower() != keyword:
        return False
    if index > 0 and _is_word_char(sql[index - 1]):
        return False
    return end >= len(sql) or not _is_word_char(sql[end])


def _find_top_level_keyword(sql: str, keyword: str, *, start: int = 0) -> int | None:
    """Find a keyword at parenthesis depth 0, ignoring quoted spans."""
    depth = 0
    quote: str | None = None
    keyword = keyword.lower()
    i = start
    while i < len(sql):
        char = sql[i]

        if quote is not None:
            if char == quote:
                # SQL string/identifier escaping commonly doubles the quote
                # character. Skip the escaped pair so the span stays quoted.
                if i + 1 < len(sql) and sql[i + 1] == quote:
                    i += 2
                    continue
                quote = None
            i += 1
            continue

        if char in ("'", '"', "`"):
            quote = char
            i += 1
            continue
        if char == "(":
            depth += 1
            i += 1
            continue
        if char == ")":
            depth = max(0, depth - 1)
            i += 1
            continue
        if depth == 0 and _keyword_at(sql, i, keyword):
            return i
        i += 1
    return None


def _read_only_select_start(sql: str) -> int | None:
    """Return the top-level SELECT start for a read-only SELECT/CTE statement."""
    leading = sql.lstrip()
    leading_offset = len(sql) - len(leading)
    if _keyword_at(leading, 0, "select"):
        return leading_offset
    if not _keyword_at(leading, 0, "with"):
        return None
    return _find_top_level_keyword(sql, "select", start=leading_offset + len("with"))


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


def quote_identifier(name: str, dialect: SqlDialect) -> str:
    """Validate a raw identifier and quote it for ``dialect``.

    Quoting is what makes a RESERVED column name usable: verified against live
    engines, an unquoted ``order`` is a syntax error on PostgreSQL ("syntax error
    at or near \\"order\\"") and on BigQuery ("Unexpected keyword ORDER"), while
    ClickHouse happens to accept it — which is exactly how an unquoted compiler
    ships green and then explodes on two of three warehouses.

    A dot-qualified name is quoted PART BY PART (``"t"."col"`` /  ``\\`t\\`.\\`col\\```),
    never as one blob: all three engines read a single-quoted ``"t.col"`` as one
    weird column name and fail with "Unrecognized name" / "does not exist"
    (verified). Empty parts (``a..b``, ``a.``) are rejected — the identifier regex
    alone would let them through.

    Security: ``validate_identifier`` runs FIRST, and its allowlist regex
    (``^[a-zA-Z_][a-zA-Z0-9_.]*$``) admits neither a backtick nor a double quote,
    so the quote character can never appear inside a part and the quoting can
    never be broken out of.
    """
    validated = validate_identifier(name)
    parts = validated.split(".")
    if any(not part for part in parts):
        msg = f"Invalid identifier: {name!r}"
        raise ValueError(msg)
    quote = _IDENTIFIER_QUOTE[dialect]
    return ".".join(f"{quote}{part}{quote}" for part in parts)


def quote_sql_string_literal(text: str, dialect: SqlDialect) -> str:
    """Quote a plain SQL string literal, escaped the way ``dialect`` demands.

    The escape is NOT shared, and getting it wrong is not cosmetic:

    * **PostgreSQL** doubles the quote (``'o''brien'``). With
      ``standard_conforming_strings`` on (the default), a backslash is a literal
      backslash, so ``'o\\'brien'`` is an *unterminated string* (verified).
    * **BigQuery** has no ``''`` escape at all: ``'o''brien'`` is read as two
      adjacent string literals and dies with "concatenated string literals must be
      separated by whitespace or comments" (verified against ZetaSQL). GoogleSQL
      escapes with a BACKSLASH (``'o\\'brien'``), and a raw newline inside a
      single-quoted literal is an "Unclosed string literal", so newlines are
      escaped too.
    * **ClickHouse** accepts both forms; it is given the backslash form so it
      matches its own adapter's ``_quote_string``.

    So the previously-shared ``''`` escaping meant ANY structured filter value
    containing an apostrophe was a hard BigQuery parse error — raised inside a
    Celery worker, long after the user saved it.

    Escaping order is load-bearing for the backslash dialects: the backslash is
    doubled FIRST, so a value ending in ``\\`` cannot escape the closing quote.
    Injection is not reachable either way — a value can only ever add PAIRED
    quotes, never an odd one (verified: ``x' OR TRUE OR 'y`` compiles to a plain
    string comparison on BigQuery, not a predicate).

    This helper intentionally does not accept arbitrary objects. It is for SQL
    operators that require string-pattern semantics (``LIKE`` / ``contains``),
    where a numeric-looking value must still be represented as a quoted string.
    """
    stripped = text.strip()
    if not stripped:
        raise ValueError("SQL string literal must not be empty")
    if "\x00" in stripped:
        raise ValueError("SQL string literal must not contain NUL bytes")
    if dialect is SqlDialect.postgres:
        return "'" + stripped.replace("'", "''") + "'"
    escaped = (
        stripped.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n").replace("\r", "\\r")
    )
    return "'" + escaped + "'"


def quote_sql_literal(value: str | int | float | bool, dialect: SqlDialect) -> str:
    """Render one scalar as an injection-safe SQL literal for ``dialect``.

    Numeric and boolean values are emitted as SQL literals (``TRUE``/``FALSE`` is
    accepted by all three engines — verified). String values are trimmed and then
    interpreted as boolean / numeric literals when they match those narrow forms;
    every other string is quoted by :func:`quote_sql_string_literal`, which is
    where the per-dialect escaping lives. This keeps visual condition-builder
    values such as ``3`` usable for ``amount > 3`` while safely quoting free text
    like ``subscription = trial``.
    """
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("SQL numeric literal must be finite")
        return repr(value)

    stripped = value.strip()
    if not stripped:
        raise ValueError("SQL literal string must not be empty")
    if "\x00" in stripped:
        raise ValueError("SQL literal string must not contain NUL bytes")

    lowered = stripped.lower()
    if lowered == "true":
        return "TRUE"
    if lowered == "false":
        return "FALSE"
    if _NUMERIC_LITERAL_RE.fullmatch(stripped):
        return stripped
    return quote_sql_string_literal(stripped, dialect)


def parse_utc_timestamp(text: str) -> datetime | None:
    """Parse a user-entered timestamp into an aware UTC datetime, or ``None``.

    Accepts the ISO-8601 forms a condition builder realistically produces (``T``
    or space separator, optional offset, trailing ``Z``). ``None`` means "this is
    not a timestamp", and the caller falls back to a plain string literal — the
    behavior before this existed — rather than guessing.

    A value with no offset is *assumed UTC*, matching
    :func:`tripl.core.bucketing.to_utc`: the whole point of typing the literal is
    that an offset-less literal would otherwise be re-read in the column's or the
    session's timezone.
    """
    candidate = text.strip()
    if not candidate or not _TIMESTAMP_TEXT_RE.match(candidate):
        return None
    normalized = candidate.replace(" ", "T", 1)
    if normalized.endswith(("Z", "z")):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return to_utc(parsed)


def quote_timestamp_literal(value: datetime, dialect: SqlDialect, *, kind: TimeKind) -> str:
    """Render a UTC instant as a literal comparable against a ``kind`` time column.

    Mirrors each adapter's own window-bound rendering (ClickHouse ``_utc_literal``,
    PostgreSQL ``_time_window_condition``, BigQuery ``_time_literal``) so a filter
    bound and a window bound cannot disagree about what instant they name.

    A bare ``'2026-01-01 00:00:00'`` string *parses* on all three engines, so this
    is not about syntax — it is about the UTC contract in
    :mod:`tripl.core.bucketing`: an offset-less literal is re-read in the COLUMN's
    timezone (ClickHouse) or the SESSION's (PostgreSQL), which silently shifts the
    comparison. Every form below pins UTC explicitly.

    BigQuery is the one dialect where the literal's *type family* must match the
    column's: ``DATETIME '2026-01-01 00:00:00+00:00'`` is an "Invalid DATETIME
    literal" (verified), because DATETIME is a zone-less wall clock.
    """
    moment = to_utc(value)
    if dialect is SqlDialect.clickhouse:
        return f"parseDateTime64BestEffort('{format_utc_literal(moment)}', 6, 'UTC')"
    if dialect is SqlDialect.postgres:
        return f"TIMESTAMPTZ '{format_utc_literal(moment)}'"
    if kind is TimeKind.datetime:
        return f"DATETIME '{moment.strftime(_BQ_DATETIME_LITERAL_FMT)}'"
    if kind is TimeKind.date:
        return f"DATE '{moment.strftime(_BQ_DATE_LITERAL_FMT)}'"
    return f"TIMESTAMP '{format_utc_literal(moment)}'"


def time_kind_of(column: str, column_types: Mapping[str, str] | None) -> TimeKind:
    """Classify a column as a time column using the fact table's stored types.

    ``column_types`` is ``{name: warehouse_type}`` (from ``FactTable.columns``).
    An unknown column — no introspected types at all, or a name that is not in
    them — is :attr:`TimeKind.unsupported`, i.e. "do not type this literal", so
    the compiler falls back to the plain string literal it emitted before.
    """
    if not column_types:
        return TimeKind.unsupported
    type_name = column_types.get(column)
    if type_name is None:
        return TimeKind.unsupported
    return classify_time(type_name)


def lint_dialect_sql(sql: str, dialect: SqlDialect) -> str | None:
    """Actionable message for SQL that cannot run on ``dialect``, else ``None``.

    A PRE-FLIGHT diagnostic, not a security control: it runs *after* the read-only
    gate and can only reject more, never admit more. Its job is to turn "a starter
    query that cannot run on the warehouse you picked" into a sentence the user can
    act on, before a save or a worker collection, instead of a driver stack trace.

    Every rule is a function that provably does NOT resolve on the target dialect,
    checked against live engines so a valid query is never flagged. In particular:

    * ``DATE_TRUNC(date_expr, part)`` DOES exist on BigQuery, so only the
      ClickHouse/Postgres ``date_trunc('day', ts)`` **string-first** form is flagged.
    * ``countIf`` is NOT flagged on BigQuery: GoogleSQL is case-insensitive, so it
      resolves to the real ``COUNTIF`` (verified).
    """
    for pattern, message in _DIALECT_RULES[dialect]:
        if pattern.search(sql):
            return message
    return None


def validate_sql_fragment(text: str) -> str:
    """Validate a raw WHERE-clause fragment (e.g. a metric ``filter_sql``).

    Intended for boolean filter expressions, not full statements. Rejects comment
    markers (``--``/``/*``/``*/``/``#``), an embedded ``;``, and any forbidden
    DDL/DML/session/``UNION`` keyword plus ``SELECT``/``WITH`` (matched on word
    boundaries, case-insensitively), so a fragment can never embed a correlated
    subquery (``user_id IN (SELECT ...)``) or a CTE. Returns ``text`` unchanged.
    Legitimate filters such as ``status IN ('a','b') AND created_at >
    '2026-01-01'`` pass (``created_at`` does not trip ``create``); probes like
    ``1=1 UNION SELECT ...`` or ``x; DROP ...`` are rejected. Raises
    ``ValueError`` (English) on violation.
    """
    for marker in _COMMENT_MARKERS:
        if marker in text:
            msg = f"Filter must not contain comments or comment markers ({marker!r})"
            raise ValueError(msg)
    if ";" in text:
        msg = "Filter must not contain ';' separators"
        raise ValueError(msg)
    forbidden = _FORBIDDEN_FRAGMENT_RE.search(text)
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

    * a single leading ``SELECT`` or top-level ``WITH ... SELECT`` CTE,
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

    if _read_only_select_start(without_trailing) is None:
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
    ``SELECT`` or ``WITH ... SELECT``, no stacked statements, no comments, no
    DDL/DML/UNION) **and** projects both the value column and the time column.
    The projection is the slice before the FROM *clause*: FROM detection is
    parenthesis-depth-aware, so a ``from`` nested in function arguments
    (``EXTRACT(EPOCH FROM ts)``, ``SUBSTRING(col FROM n)``) is not mistaken for
    the clause boundary.

    Numeric-ness of the value column is enforced downstream at execution time;
    here we only require that both columns are projected. Raises ``ValueError``
    (English) on any violation.
    """
    without_trailing = validate_select_sql_safety(metric_sql)

    select_index = _read_only_select_start(without_trailing)
    if select_index is None:  # Defensive: already checked by validate_select_sql_safety.
        msg = "Metric SQL must be a single read-only SELECT statement"
        raise ValueError(msg)
    select_sql = without_trailing[select_index:]
    from_index = _clause_from_index(select_sql)
    projection = select_sql if from_index is None else select_sql[:from_index]

    for column, label in ((value_column, "value"), (time_column, "time")):
        if not re.search(rf"\b{re.escape(column)}\b", projection, re.IGNORECASE):
            msg = f"Metric SQL must project the {label} column {column!r}"
            raise ValueError(msg)

    return without_trailing
