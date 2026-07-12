from __future__ import annotations

import logging
import math
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from typing import override

import psycopg

from tripl.core.adapters.base import (
    AggregateSpec,
    BaseAdapter,
    ColumnInfo,
    FieldContractExpectation,
    FieldContractViolation,
    SchemaColumn,
    SchemaTable,
)
from tripl.core.adapters.measure_validator import (
    build_aggregate_sql,
    coerce_aggregation,
    validate_measure_column,
)
from tripl.core.bucketing import EPOCH, WEEK_ORIGIN, format_utc_literal
from tripl.core.intervals import IntervalUnit, get_interval
from tripl.models.domain_enums import MetricAggregation

logger = logging.getLogger(__name__)

# Hard cap on catalog rows pulled for SQL-editor autocomplete so a schema with
# thousands of wide tables can't blow up the response. The cap is generous
# because introspection now spans every non-system schema (one row per column
# per table across all of them), so a multi-schema database needs plenty of
# headroom before its visible tables get truncated.
_SCHEMA_ROW_LIMIT = 50000

# System schemas that hold Postgres internals, not user data. They are excluded
# from catalog introspection so autocomplete only surfaces queryable user tables.
_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")

# Cap on how much user-supplied SQL (which may embed warehouse credentials or
# PII column names) we ever emit to logs. Query logs go to DEBUG so the full
# statement never lands at INFO.
_SQL_LOG_MAX_CHARS = 300


def _truncate_sql(sql: str) -> str:
    return sql[:_SQL_LOG_MAX_CHARS] + ("..." if len(sql) > _SQL_LOG_MAX_CHARS else "")


# date_bin() — which every bucket expression depends on — was added in PostgreSQL
# 14. libpq reports the server version as MMmmmm (140005 == 14.5), so this is the
# integer floor of a supported server.
_MIN_SERVER_VERSION = 140000

_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")
_IDENTIFIER_PART_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def _quote_ident(name: str) -> str:
    # Identifiers are pre-validated by _validate_column; this just adds the quoting.
    return '"' + name.replace('"', '""') + '"'


def _is_local_host(host: str) -> bool:
    return host in {"localhost", "127.0.0.1", "::1", ""}


def _format_server_version(version: int) -> str:
    """Render libpq's packed server version (140005) as a human "14.5"."""
    return f"{version // 10000}.{version % 10000}"


# --- connection settings -----------------------------------------------------

#: The connection parameters this adapter understands. Anything else is REJECTED
#: rather than swallowed by ``**kwargs``: a typo'd or inapplicable option that is
#: silently dropped looks configured but isn't, which for a TLS option means the
#: operator believes the link is encrypted when it is not.
_SUPPORTED_PARAMS = (
    "timeout_seconds",
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "search_path",
)

#: libpq's TLS modes, weakest first. A closed allowlist: an unrecognized value is
#: rejected, never passed through to libpq (which would fall back to its own
#: default) and never dropped (which would silently downgrade the connection).
_SSL_MODES = ("disable", "allow", "prefer", "require", "verify-ca", "verify-full")

#: Modes that check the server certificate against a CA, and so need one.
_SSL_VERIFYING_MODES = frozenset({"verify-ca", "verify-full"})

#: Default when the data source does not pin a mode. A remote host gets ``require``,
#: not libpq's ``prefer``: ``prefer`` negotiates TLS if the server offers it and
#: silently falls back to PLAINTEXT if it doesn't, so it guarantees nothing and a
#: stripped connection is indistinguishable from a healthy one. ``require`` fails
#: loudly instead; an operator whose server genuinely has no TLS can still ask for
#: ``prefer``/``disable`` explicitly, which is a decision on the record rather than
#: a default nobody chose. localhost keeps ``prefer`` — dev and docker Postgres
#: usually have no certificate at all, and the traffic never leaves the machine.
_DEFAULT_REMOTE_SSLMODE = "require"
_DEFAULT_LOCAL_SSLMODE = "prefer"

#: We are handed certificate/key PEM *content* (it lives in an encrypted DB column),
#: while libpq only takes filesystem paths. Anything without a PEM header is a
#: mistake worth shouting about — most likely a path, which we must not silently
#: treat as a certificate.
_PEM_HEADER = "-----BEGIN"

#: libpq's key-file permission check: a private key readable by group or other is
#: REFUSED outright ("private key file has group or world access"). The temp dir is
#: 0700 and every file in it 0600, so the check passes and the key is never exposed
#: to another user on the host.
_TLS_DIR_MODE = 0o700
_TLS_FILE_MODE = 0o600


@dataclass(frozen=True)
class _TlsFiles:
    """Materialized TLS material: a private temp dir and the libpq paths into it."""

    directory: str | None
    paths: dict[str, str]


def _resolve_sslmode(host: str, sslmode: str | None) -> str:
    if sslmode is None:
        return _DEFAULT_LOCAL_SSLMODE if _is_local_host(host) else _DEFAULT_REMOTE_SSLMODE
    if sslmode not in _SSL_MODES:
        msg = f"Unsupported sslmode: {sslmode!r}. Supported modes are: {', '.join(_SSL_MODES)}."
        raise ValueError(msg)
    return sslmode


def _tls_pem_material(
    *,
    sslmode: str,
    sslrootcert: str | None,
    sslcert: str | None,
    sslkey: str | None,
) -> dict[str, str]:
    """Validate the TLS inputs and return the PEMs to materialize, by libpq name.

    Rejects the combinations libpq would either ignore or die on much later:
    certificate material handed to a connection that will never negotiate TLS, a
    verifying mode with no CA to verify against, and half of a client-certificate
    pair. All three are "inapplicable parameters", and silently accepting any of
    them means the connection is not what the configuration says it is.
    """
    pems = {"sslrootcert": sslrootcert, "sslcert": sslcert, "sslkey": sslkey}
    provided = {name: pem for name, pem in pems.items() if pem}

    if sslmode == "disable" and provided:
        msg = (
            f"sslmode=disable never negotiates TLS, so {', '.join(sorted(provided))} "
            "cannot be applied. Remove the certificate material or raise sslmode."
        )
        raise ValueError(msg)
    if sslmode in _SSL_VERIFYING_MODES and not sslrootcert:
        msg = f"sslmode={sslmode} verifies the server certificate but no sslrootcert was given."
        raise ValueError(msg)
    if bool(sslcert) != bool(sslkey):
        msg = "Client certificate authentication needs both sslcert and sslkey, not one of them."
        raise ValueError(msg)
    for name, pem in provided.items():
        if _PEM_HEADER not in pem:
            # Never echo the value: sslkey is a private key.
            msg = f"{name} must be PEM content (a '{_PEM_HEADER}...' block), not a file path."
            raise ValueError(msg)
    return provided


def _materialize_tls_files(pems: dict[str, str]) -> _TlsFiles:
    """Write PEM content to a private 0600 temp file per entry, for libpq to read.

    The directory is created 0700 and the files 0600 *explicitly* (``os.open``'s
    mode is masked by the process umask, so it is not on its own a guarantee).
    Callers own the cleanup: :meth:`PostgresAdapter.close` removes the directory,
    and a failed connect removes it too, so a private key never outlives the
    connection it was created for.
    """
    if not pems:
        return _TlsFiles(None, {})
    directory = tempfile.mkdtemp(prefix="tripl-pg-tls-")
    os.chmod(directory, _TLS_DIR_MODE)
    paths: dict[str, str] = {}
    try:
        for name, pem in pems.items():
            path = os.path.join(directory, f"{name}.pem")
            handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, _TLS_FILE_MODE)
            with os.fdopen(handle, "w") as file:
                file.write(pem if pem.endswith("\n") else pem + "\n")
            os.chmod(path, _TLS_FILE_MODE)
            paths[name] = path
    except OSError:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    return _TlsFiles(directory, paths)


#: A schema name in a ``search_path``. Deliberately the same shape as
#: ``schemas.data_source._SEARCH_PATH_RE``, which validates the value on the way IN:
#: a legal Postgres identifier may contain ``$`` after the first character, and the
#: two layers must accept exactly the same set or a config the API took would be
#: rejected at connect time. A leading ``$`` is still out, so ``$user`` cannot slip
#: through either.
_SEARCH_PATH_PART_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_$]*$")


def _validated_search_path(search_path: str) -> str:
    """Check a ``search_path`` is a plain identifier list before it is interpolated.

    ``search_path`` is a list of *identifiers*, not a literal, so it cannot be bound
    as a parameter and has to be interpolated into the libpq startup options — which
    makes it an injection vector unless it is checked. Only bare identifiers are
    allowed (no quoting, no ``$user``, no whitespace), which is also what keeps the
    space-separated ``options`` string unambiguous.
    """
    parts = [part.strip() for part in search_path.split(",")]
    if not parts or any(not part for part in parts):
        msg = f"Invalid search_path: {search_path!r}"
        raise ValueError(msg)
    invalid = [part for part in parts if not _SEARCH_PATH_PART_RE.match(part)]
    if invalid:
        msg = (
            f"Invalid search_path schema name(s): {', '.join(repr(part) for part in invalid)}. "
            "search_path takes a comma-separated list of plain identifiers."
        )
        raise ValueError(msg)
    return ",".join(parts)


# --- field contracts ---------------------------------------------------------

#: A finite decimal or scientific-notation number, and nothing else. Guards the
#: ``::double precision`` cast in the range-contract SQL: Postgres RAISES on a bad
#: cast (``invalid input syntax for type double precision``) rather than yielding
#: NULL the way ClickHouse's ``toFloat64OrNull`` does, and one malformed value in
#: one row would abort the whole contract query. The CASE only casts what already
#: matched, so a malformed value falls out as NULL — i.e. as BAD — instead.
_FINITE_NUMBER_RE = r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$"

#: The non-finite spellings ``float()`` and ``toFloat64OrNull`` both accept, matched
#: case-insensitively (``~*``). They are handled apart from the cast because
#: PostgreSQL orders NaN as GREATER THAN every other float, while Python and
#: ClickHouse make every NaN comparison false — so a NaN routed through the cast
#: would report as "above max" on Postgres and as "in range" everywhere else.
#: Keeping NaN out of the comparison entirely is what makes the three agree.
_POSITIVE_INF_RE = r"^[+]?inf(inity)?$"
_NEGATIVE_INF_RE = r"^[-]inf(inity)?$"
_NAN_RE = r"^[+-]?nan$"


def _float_literal(value: float) -> str:
    number = float(value)
    if not math.isfinite(number):
        msg = f"Contract bound must be a finite number, got {value!r}"
        raise ValueError(msg)
    return repr(number)


def _jsonb_object(value_sql: str) -> str:
    """Coerce a json/jsonb expression to a jsonb *object*, or an empty object.

    ``json`` has to be cast to ``jsonb`` before any of the jsonb operators work,
    and a SQL NULL, a JSON scalar or a JSON array at the root has no keys to walk
    — all three collapse to ``{}`` so the path walk yields no rows instead of
    erroring or returning NULL.
    """
    return (
        f"CASE WHEN jsonb_typeof({value_sql}::jsonb) = 'object' "
        f"THEN {value_sql}::jsonb ELSE '{{}}'::jsonb END"
    )


#: Recursive descent over a jsonb document, emitting one row per *leaf*: a dotted
#: path and the jsonb value at it. Objects are the only thing recursed into, so an
#: array or a JSON ``null`` is a leaf at its own path (never indexed or dropped),
#: which is what ClickHouse's ``JSONAllPaths`` reports for the same document.
#: The caller supplies the seed relation as ``{seed}`` (any relation with a single
#: jsonb-object column ``_doc``).
_JSON_LEAF_WALK = (
    "_walk(_path, _value) AS ("
    "SELECT _kv.key, _kv.value FROM {seed} AS _seed, LATERAL jsonb_each(_seed._doc) AS _kv "
    "UNION ALL "
    "SELECT _walk._path || '.' || _kv.key, _kv.value "
    "FROM _walk, LATERAL jsonb_each(_walk._value) AS _kv "
    "WHERE jsonb_typeof(_walk._value) = 'object'"
    ")"
)


class PostgresAdapter(BaseAdapter):
    """Postgres-backed warehouse adapter mirroring the ClickHouse semantics.

    Maps ClickHouse-specific features to standard SQL:
      - toStartOfInterval → date_bin (PostgreSQL >= 14; see test_connection)
      - JSONAllPaths      → a recursive jsonb_each walk (_JSON_LEAF_WALK) that
                            enumerates full nested leaf paths ("user.address.city"),
                            not just the top-level keys jsonb_object_keys returns
      - GROUPING SETS     → same syntax (Postgres supports it natively)
      - multiIf           → CASE WHEN / THEN
      - LIMIT n BY col    → ROW_NUMBER() OVER (PARTITION BY ...) wrapper
      - countIf/anyIf     → count(*) / min(...) FILTER (WHERE ...)
      - toFloat64OrNull   → a regex-guarded ::double precision cast (Postgres RAISES
                            on a bad cast where ClickHouse returns NULL)

    Everything is UTC: the session timezone is pinned on connect and every window
    bound is an explicit-offset TIMESTAMPTZ literal, so neither a non-UTC server
    nor a non-UTC role can shift a window or a bucket. See
    :mod:`tripl.core.bucketing` for the contract.

    **Known dialect divergence — regex contracts.** ``regex_violation`` compiles the
    stored pattern with Postgres's ``~`` operator, which is POSIX ARE, while the
    Python fallback uses ``re.search`` and ClickHouse uses RE2. All three are
    unanchored partial matches, and all three agree on ordinary patterns (literals,
    character classes, anchors, ``|``, quantifiers, ``\\d``/``\\w``/``\\s``). They do
    NOT agree on everything, and we do not pretend otherwise:

    * ``\\b`` is a word boundary in Python; in POSIX ARE it is a BACKSPACE character
      (the word-boundary escape is ``\\y``). A ``\\b``-anchored pattern therefore
      matches nothing here and flags every row as bad.
    * ``$`` in Python also matches just before a trailing newline; in POSIX ARE it
      only matches at the very end of the string.
    * Python-only syntax (``(?P<name>...)``, lookbehind spelt ``(?<=...)``) is not
      valid ARE, and an invalid pattern makes the *statement* fail — one bad regex
      takes down the whole contract query rather than just its own expectation.

    A contract that sticks to portable regex syntax gets identical answers from all
    three warehouses; that is what the conformance gate pins.
    """

    #: Set only when TLS material had to be written to disk. A class-level default
    #: keeps ``close()`` safe on an adapter built with ``object.__new__`` (the unit
    #: tests do that to exercise SQL generation without a server).
    _tls_dir: str | None = None

    def __init__(
        self,
        host: str,
        port: int,
        database: str,
        username: str = "",
        password: str = "",
        timeout_seconds: int | None = None,
        sslmode: str | None = None,
        sslrootcert: str | None = None,
        sslcert: str | None = None,
        sslkey: str | None = None,
        search_path: str | None = None,
        **kwargs: object,
    ) -> None:
        # An unknown connection parameter is a hard error, not something **kwargs
        # quietly eats. The alternative — accepting `sslmod=verify-full` and
        # connecting in plaintext anyway — is the failure mode this guard exists
        # to prevent (tripl-64n8.7: "rejected, not ignored").
        if kwargs:
            unknown = ", ".join(sorted(kwargs))
            msg = (
                f"Unsupported PostgreSQL connection parameter(s): {unknown}. "
                f"Supported: {', '.join(_SUPPORTED_PARAMS)}."
            )
            raise ValueError(msg)

        # connect_timeout bounds the TCP/handshake; statement_timeout (set
        # server-side via libpq options) caps every query so a runaway
        # base_query is cancelled by Postgres long before Celery's hard limit
        # SIGKILLs the worker. statement_timeout is in milliseconds.
        connect_timeout = timeout_seconds if timeout_seconds and timeout_seconds > 0 else None
        # timezone=UTC pins the *session*, not just our literals: an offset-less
        # timestamp column is compared and binned in the session timezone, so a
        # server or role whose TimeZone is, say, Europe/Berlin would otherwise
        # shift every window bound and every bucket edge by its UTC offset. Set
        # through the same libpq `options` channel as statement_timeout so there
        # is exactly one mechanism, applied before the first query runs.
        option_parts = ["-c timezone=UTC"]
        if connect_timeout is not None:
            option_parts.append(f"-c statement_timeout={connect_timeout * 1000}")
        if search_path is not None:
            # Validated to a bare identifier list, so it can neither inject SQL nor
            # smuggle whitespace into the space-separated options string.
            option_parts.append(f"-c search_path={_validated_search_path(search_path)}")
        options = " ".join(option_parts)

        mode = _resolve_sslmode(host, sslmode)
        tls = _materialize_tls_files(
            _tls_pem_material(
                sslmode=mode,
                sslrootcert=sslrootcert,
                sslcert=sslcert,
                sslkey=sslkey,
            )
        )
        self._tls_dir = tls.directory

        try:
            self._conn = psycopg.connect(
                host=host,
                port=port,
                dbname=database,
                user=username or "postgres",
                password=password or "",
                autocommit=True,
                connect_timeout=connect_timeout,
                options=options,
                sslmode=mode,
                # libpq reads the certificate material from disk; a None is dropped
                # from the conninfo rather than sent as an empty path.
                sslrootcert=tls.paths.get("sslrootcert"),
                sslcert=tls.paths.get("sslcert"),
                sslkey=tls.paths.get("sslkey"),
            )
        except BaseException:
            # A refused connection must not leave a private key on disk.
            self._remove_tls_files()
            raise
        self._allowed_columns: set[str] = set()
        self._type_names: dict[int, str] = {}

    def _remove_tls_files(self) -> None:
        if self._tls_dir is None:
            return
        shutil.rmtree(self._tls_dir, ignore_errors=True)
        self._tls_dir = None

    def close(self) -> None:
        try:
            self._conn.close()
        finally:
            # The certificate and key files exist only for this connection's
            # lifetime; the key in particular must not be left behind.
            self._remove_tls_files()

    def test_connection(self) -> bool:
        """Probe the server and refuse one too old to bucket time correctly.

        Every time-bucketed query goes through ``date_bin``, which only exists on
        PostgreSQL 14+. Without this check an older server fails much later, deep
        inside a scan or a metric collection, as an opaque "function date_bin(...)
        does not exist". The version comes from the libpq handshake, so the guard
        costs no extra round trip.
        """
        server_version = self._conn.info.server_version
        if server_version < _MIN_SERVER_VERSION:
            minimum = _MIN_SERVER_VERSION // 10000
            msg = (
                f"PostgreSQL {_format_server_version(server_version)} is too old for tripl: "
                f"every time-bucket query uses date_bin(), which was added in PostgreSQL "
                f"{minimum}. Upgrade the server to {minimum} or newer."
            )
            raise ValueError(msg)
        with self._conn.cursor() as cur:
            cur.execute("SELECT 1")
            row = cur.fetchone()
            return bool(row and row[0] == 1)

    def _type_name(self, oid: int) -> str:
        cached = self._type_names.get(oid)
        if cached is not None:
            return cached
        info = self._conn.adapters.types.get(oid)
        name = info.name if info is not None else f"oid_{oid}"
        self._type_names[oid] = name
        return name

    def get_columns(self, base_query: str) -> list[ColumnInfo]:
        with self._conn.cursor() as cur:
            cur.execute(f"SELECT * FROM ({base_query}) AS _src LIMIT 0")
            columns: list[ColumnInfo] = []
            for desc in cur.description or []:
                type_name = self._type_name(desc.type_code)
                # Postgres cursor descriptions don't expose nullability — be
                # conservative and assume nullable; the analyzer side rechecks.
                columns.append(ColumnInfo(name=desc.name, type_name=type_name, is_nullable=True))
        self._allowed_columns = {c.name for c in columns}
        return columns

    def get_schema_tables(self) -> list[SchemaTable]:
        # Introspect every non-system schema, not just the search_path: on real
        # Postgres the user's tables often live in a schema outside the connection
        # search_path, or they reference `schema.table` across schemas.
        # `table_schema = current_schema()` is computed server-side so the
        # "bare vs qualified" decision tracks the connection's default schema
        # (the first existing entry of search_path, typically `public`).
        excluded = ", ".join(f"'{name}'" for name in _SYSTEM_SCHEMAS)
        sql = (
            "SELECT table_schema, table_name, column_name, data_type, "
            "(table_schema = current_schema()) AS is_current_schema "
            "FROM information_schema.columns "
            f"WHERE table_schema NOT IN ({excluded}) "
            f"ORDER BY table_schema, table_name, ordinal_position LIMIT {_SCHEMA_ROW_LIMIT}"
        )
        logger.debug("PG schema introspection query: %s", _truncate_sql(sql))
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall()
        # Tables in the default schema keep their bare name (`events`); tables in
        # any other schema are qualified as `schema.table` (`analytics.orders`).
        # The frontend relies on this: a table name has at most one dot, and only
        # when it lives outside the default schema.
        columns_by_table: dict[str, list[SchemaColumn]] = {}
        for table_schema, table_name, column_name, data_type, is_current_schema in rows:
            qualified_name = (
                str(table_name) if is_current_schema else f"{table_schema}.{table_name}"
            )
            columns_by_table.setdefault(qualified_name, []).append(
                SchemaColumn(name=str(column_name), data_type=str(data_type))
            )
        return [
            SchemaTable(name=table, columns=columns) for table, columns in columns_by_table.items()
        ]

    def get_preview_rows(
        self,
        base_query: str,
        limit: int = 10,
        *,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        sql = f"SELECT * FROM ({base_query}) AS _src{where_clause} LIMIT {int(limit)}"
        logger.debug("PG preview query: %s", _truncate_sql(sql))
        with self._conn.cursor() as cur:
            cur.execute(sql)
            names = [d.name for d in cur.description or []]
            rows = [tuple(r) for r in cur.fetchall()]
        return names, rows

    def _validate_column(self, column: str) -> str:
        if not _IDENTIFIER_RE.match(column):
            msg = f"Invalid column name: {column}"
            raise ValueError(msg)
        if self._allowed_columns and column not in self._allowed_columns:
            msg = f"Column {column!r} not found in query result"
            raise ValueError(msg)
        return column

    def _bucket_expression(self, time_column: str, interval_code: str) -> str:
        """Translate an interval code into PostgreSQL bucket SQL.

        Must agree with ``tripl.core.bucketing.floor_to_bucket``. ``date_bin``
        measures from whatever origin it is handed, so the origin is what encodes
        the contract: sub-week intervals bin from the epoch, and a week bins from
        ``WEEK_ORIGIN`` (the first Monday) rather than from the epoch itself, which
        was a Thursday. The origin literal carries an explicit ``+00:00`` offset so
        a session running in a non-UTC ``TimeZone`` cannot slide the grid.
        """
        spec = get_interval(interval_code)
        col = _quote_ident(self._validate_column(time_column))
        if spec.unit is IntervalUnit.week:
            origin = format_utc_literal(WEEK_ORIGIN)
            return f"date_bin(INTERVAL '{7 * spec.count} days', {col}, TIMESTAMPTZ '{origin}')"
        origin = format_utc_literal(EPOCH)
        return (
            f"date_bin(INTERVAL '{spec.count} {spec.unit.value}s', {col}, TIMESTAMPTZ '{origin}')"
        )

    def _json_path_expression(self, column: str, path: str) -> str:
        parts = [part for part in path.split(".") if part]
        if not parts:
            raise ValueError(f"Invalid JSON path: {path}")
        if any(not _IDENTIFIER_PART_RE.match(part) for part in parts):
            raise ValueError(f"Unsupported JSON path: {path}")

        expr = _quote_ident(self._validate_column(column))
        for part in parts[:-1]:
            expr += f" -> '{part}'"
        # Last step uses ->> only if we want text; for JSONB-string emission we
        # keep -> and cast to text.
        expr += f" -> '{parts[-1]}'"
        return expr

    def _string_value_expression(self, column: str) -> str:
        return f"COALESCE({_quote_ident(self._validate_column(column))}::text, '')"

    def _quote_string(self, value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    def _time_window_condition(
        self,
        time_column: str,
        time_from: datetime,
        time_to: datetime,
    ) -> str:
        """The half-open ``time_from <= t < time_to`` predicate, in UTC.

        The one place a window bound is rendered. Bounds go through
        ``format_utc_literal`` and are emitted as ``TIMESTAMPTZ`` with an explicit
        ``+00:00``: an offset-less literal (what ``strftime`` used to produce) is
        read in the *session* timezone, silently sliding the whole window on a
        non-UTC server. A ``timestamp``-typed column is promoted to timestamptz for
        the comparison using the session timezone, which __init__ pins to UTC, so
        naive and aware columns agree.
        """
        quoted = _quote_ident(self._validate_column(time_column))
        return (
            f"{quoted} >= TIMESTAMPTZ '{format_utc_literal(time_from)}' "
            f"AND {quoted} < TIMESTAMPTZ '{format_utc_literal(time_to)}'"
        )

    def _time_window_where_clause(
        self,
        time_column: str | None,
        time_from: datetime | None,
        time_to: datetime | None,
    ) -> str:
        """The optional-window variant: a leading-space WHERE clause, or ``""``."""
        if time_column is None or time_from is None or time_to is None:
            return ""
        return f" WHERE {self._time_window_condition(time_column, time_from, time_to)}"

    def _json_paths_expression(self, column: str) -> str:
        """Sorted text[] of the document's nested leaf paths, for one row.

        Parity with ClickHouse's ``arraySort(JSONAllPaths(col))``: full dotted leaf
        paths ("user.address.city"), not the top-level keys ``jsonb_object_keys``
        returns. Semantics, made explicit because the three warehouses have to
        agree on them:

        * **Objects** are recursed into and are *not* themselves paths; only leaves
          are emitted. An empty object is therefore not a path (it has no leaf) —
          the same thing ``json_paths.flatten_json_paths`` does locally.
        * **Arrays are leaves.** The array lands at its own path and is never
          indexed into, so ``{"tags": ["a"]}`` yields ``tags``, not ``tags.0``.
        * **JSON nulls are leaves.** ``{"a": null}`` yields ``a``: the key exists in
          the document, so it stays discoverable rather than vanishing.
        * A **SQL NULL** column, or a JSON scalar/array at the *root*, has no keys
          and yields ``ARRAY[]::text[]`` — an empty array, never NULL, so it groups
          as a value like any other.
        """
        c = _quote_ident(self._validate_column(column))
        seed = f"(SELECT {_jsonb_object(c)} AS _doc)"
        return (
            "(SELECT COALESCE(array_agg(DISTINCT _leaf._path ORDER BY _leaf._path), "
            "ARRAY[]::text[]) FROM ("
            f"WITH RECURSIVE {_JSON_LEAF_WALK.format(seed=seed)} "
            "SELECT _path FROM _walk WHERE jsonb_typeof(_value) <> 'object'"
            ") AS _leaf(_path))"
        )

    @override
    def get_json_path_samples(
        self,
        base_query: str,
        json_columns: list[str],
        *,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
        path_limit: int = 1000,
        sample_limit: int = 3,
        sample_row_limit: int = 1000,
    ) -> dict[str, dict[str, list[object]]]:
        """Discover nested JSON paths (and samples) warehouse-side, not row-side.

        Replaces BaseAdapter's fallback, which pulled whole rows back and flattened
        them in Python. One query per JSON column walks the document server-side,
        so the UI sees path candidates from a much wider row sample at a fraction of
        the transfer. The walk is bounded by ``sample_row_limit`` source rows
        (recursion aside, a GROUP BY would otherwise scan the whole source), by
        ``path_limit`` distinct paths and by ``sample_limit`` values per path.

        Samples come back as JSON text (``"foo"``, ``42``, ``{"a":1}``), matching
        ClickHouse's ``toJSONString`` output, which the shared
        ``decode_json_path_value`` helper parses. Paths whose keys the extraction
        expression cannot address are skipped visibly (logged), not silently
        emitted and then broken at scan time.
        """
        if not json_columns or path_limit <= 0 or sample_limit <= 0 or sample_row_limit <= 0:
            return {column: {} for column in json_columns}

        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        samples_by_column: dict[str, dict[str, list[object]]] = {}

        for column in json_columns:
            c = self._validate_column(column)
            seed = (
                f"(SELECT {_jsonb_object(_quote_ident(c))} AS _doc "
                f"FROM ({base_query}) AS _src{where_clause} LIMIT {int(sample_row_limit)})"
            )
            # A JSON null renders as the text 'null'; it is ordered last so it only
            # occupies a sample slot for a path that has nothing else to show.
            sql = (
                f"WITH RECURSIVE {_JSON_LEAF_WALK.format(seed=seed)}, "
                "_leaf AS ("
                "SELECT DISTINCT _path, _value::text AS _text FROM _walk "
                "WHERE jsonb_typeof(_value) <> 'object'"
                "), _ranked AS ("
                "SELECT _path, _text, "
                "DENSE_RANK() OVER (ORDER BY _path) AS _prank, "
                "ROW_NUMBER() OVER (PARTITION BY _path ORDER BY (_text = 'null'), _text) AS _vrank "
                "FROM _leaf"
                ") "
                "SELECT _path, _text FROM _ranked "
                f"WHERE _prank <= {int(path_limit)} AND _vrank <= {int(sample_limit)} "
                "ORDER BY _path, _vrank"
            )
            logger.debug("PG JSON path discovery query: %s", _truncate_sql(sql))
            with self._conn.cursor() as cur:
                cur.execute(sql)
                rows = cur.fetchall()

            column_samples: dict[str, list[object]] = {}
            for raw_path, raw_text in rows:
                path = str(raw_path)
                try:
                    self._json_path_expression(c, path)
                except ValueError:
                    logger.info("Skipping unsupported JSON path %s.%s", c, path)
                    continue
                # The path is registered even when its only value is a JSON null,
                # so a null-valued key is still discoverable (with no samples).
                samples = column_samples.setdefault(path, [])
                if raw_text is None or raw_text == "null":
                    continue
                samples.append(raw_text)
            samples_by_column[c] = column_samples

        return samples_by_column

    def _contract_where_clause(
        self,
        time_column: str | None,
        time_from: datetime | None,
        time_to: datetime | None,
        group_column: str | None,
        group_value: str | None,
    ) -> str:
        """The scan window plus the optional event-type filter, as one WHERE clause."""
        conditions: list[str] = []
        if time_column is not None and time_from is not None and time_to is not None:
            conditions.append(self._time_window_condition(time_column, time_from, time_to))
        if group_column is not None:
            # COALESCE(col::text, '') = 'value' — the same NULL-as-empty-string
            # comparison ClickHouse makes with ifNull(toString(col), '').
            expected = self._quote_string(group_value or "")
            conditions.append(f"{self._string_value_expression(group_column)} = {expected}")
        if not conditions:
            return ""
        return " WHERE " + " AND ".join(conditions)

    def _contract_bad_condition(self, expectation: FieldContractExpectation) -> str | None:
        """The predicate that makes one row BAD, or ``None`` if the contract is a no-op.

        Mirrors ``ClickHouseAdapter._contract_select_sql`` clause for clause, because
        the two must agree on every row of every fixture:

        * ``required_null_violation`` — a NULL *is* the violation.
        * everything else — a NULL row is neither bad nor counted; it is skipped.
        * ``range_violation`` — a value that does not parse as a number is BAD, the
          same verdict ``float(text)`` raising gives the Python fallback and
          ``toFloat64OrNull`` returning NULL gives ClickHouse.

        An expectation with nothing to check (an enum with no options, a regex with
        no pattern, a range with neither bound) yields ``None`` and is dropped, so it
        cannot manufacture a violation out of a contract that says nothing.
        """
        quoted = _quote_ident(self._validate_column(expectation.field_name))
        value_expr = f"COALESCE({quoted}::text, '')"
        present = f"{quoted} IS NOT NULL"

        if expectation.drift_type == "required_null_violation":
            return f"{quoted} IS NULL"
        if expectation.drift_type == "enum_violation":
            if not expectation.enum_options:
                return None
            options = ", ".join(self._quote_string(option) for option in expectation.enum_options)
            return f"{present} AND {value_expr} NOT IN ({options})"
        if expectation.drift_type == "regex_violation":
            if not expectation.regex:
                return None
            # `~` is an unanchored POSIX match, so it accepts exactly what the
            # fallback's re.search accepts — for the patterns the two dialects
            # share. POSIX ARE is NOT Python `re`: see the class docstring.
            pattern = self._quote_string(expectation.regex)
            return f"{present} AND NOT ({value_expr} ~ {pattern})"
        if expectation.drift_type == "range_violation":
            if expectation.min_value is None and expectation.max_value is None:
                return None
            # Cast only what already looks like a number (see _FINITE_NUMBER_RE):
            # a bare `::double precision` on 'twelve' RAISES and takes the whole
            # contract query down with it. Anything unparseable stays NULL here.
            numeric_expr = (
                f"CASE WHEN {value_expr} ~ '{_FINITE_NUMBER_RE}' "
                f"THEN {value_expr}::double precision "
                f"WHEN {value_expr} ~* '{_POSITIVE_INF_RE}' THEN 'Infinity'::double precision "
                f"WHEN {value_expr} ~* '{_NEGATIVE_INF_RE}' THEN '-Infinity'::double precision "
                "END"
            )
            bounds: list[str] = []
            if expectation.min_value is not None:
                bounds.append(f">= {_float_literal(expectation.min_value)}")
            if expectation.max_value is not None:
                bounds.append(f"<= {_float_literal(expectation.max_value)}")
            in_range = " AND ".join(f"({numeric_expr}) {bound}" for bound in bounds)
            # COALESCE(..., TRUE) is what turns "did not parse" into BAD: an
            # unparseable value leaves the comparison NULL, and NULL would
            # otherwise be dropped by the aggregate FILTER rather than counted.
            # NaN is excluded first — Postgres sorts NaN above every float, while
            # Python and ClickHouse make every NaN comparison false, so letting it
            # reach the comparison is the one way these three disagree.
            return (
                f"{present} AND NOT ({value_expr} ~* '{_NAN_RE}') "
                f"AND COALESCE(NOT ({in_range}), TRUE)"
            )
        return None

    def _contract_select_sql(
        self,
        expectation: FieldContractExpectation,
        *,
        base_query: str,
        where_clause: str,
        index: int,
    ) -> str | None:
        bad_condition = self._contract_bad_condition(expectation)
        if bad_condition is None:
            return None

        quoted = _quote_ident(self._validate_column(expectation.field_name))
        value_expr = f"COALESCE({quoted}::text, '')"
        is_required = expectation.drift_type == "required_null_violation"
        # required_null counts NULLs in the denominator (a NULL is the thing being
        # measured); every other drift type measures only the non-null population.
        total_expr = "count(*)" if is_required else f"count(*) FILTER (WHERE {quoted} IS NOT NULL)"
        # One sample value, like ClickHouse's anyIf — min() rather than an arbitrary
        # pick so the sample is deterministic, and because it needs O(1) memory even
        # when millions of rows are bad (array_agg would materialize all of them).
        sample_source = "'<NULL>'::text" if is_required else value_expr
        sample_expr = f"min({sample_source}) FILTER (WHERE {bad_condition})"

        threshold = max(0.0, min(1.0, expectation.threshold))
        rate_expr = "bad_count::double precision / total_count"
        return (
            "SELECT "
            f"{self._quote_string(expectation.field_name)}::text AS field_name, "
            f"{self._quote_string(expectation.drift_type)}::text AS drift_type, "
            "bad_count, "
            "total_count, "
            f"{threshold:.12g}::double precision AS threshold, "
            f"{rate_expr} AS bad_rate, "
            "sample_value, "
            f"{int(index)} AS _ord "
            "FROM ("
            "SELECT "
            f"count(*) FILTER (WHERE {bad_condition}) AS bad_count, "
            f"{total_expr} AS total_count, "
            f"{sample_expr} AS sample_value "
            f"FROM ({base_query}) AS _src{where_clause}"
            f") AS _contract_{int(index)} "
            "WHERE total_count > 0 "
            "AND bad_count > 0 "
            f"AND {rate_expr} > {threshold:.12g}"
        )

    @override
    def validate_field_contracts(
        self,
        base_query: str,
        expectations: list[FieldContractExpectation],
        *,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
        group_column: str | None = None,
        group_value: str | None = None,
        limit: int = 50000,
    ) -> list[FieldContractViolation]:
        """Evaluate every field contract warehouse-side, over the FULL window.

        Replaces BaseAdapter's fallback, which pulled ``limit`` (50,000) rows back
        and counted them in Python: a violation that first appears at row 50,001 was
        invisible to it, and the ``bad_rate`` it reported described the sample rather
        than the data. Here the counting happens in Postgres over every row the
        window selects, so both numbers are exact whatever the table's size.

        One query for all expectations: each contributes a UNION ALL branch that
        already applies its own threshold, so only actual violations travel back.
        ``ORDER BY _ord`` keeps them in the order the caller listed them.
        """
        if not expectations:
            return []

        where_clause = self._contract_where_clause(
            time_column,
            time_from,
            time_to,
            group_column,
            group_value,
        )
        selects = [
            sql
            for index, expectation in enumerate(expectations)
            if (
                sql := self._contract_select_sql(
                    expectation,
                    base_query=base_query,
                    where_clause=where_clause,
                    index=index,
                )
            )
            is not None
        ]
        if not selects:
            return []

        sql = (
            "SELECT field_name, drift_type, bad_count, total_count, threshold, "
            "bad_rate, sample_value FROM ("
            + " UNION ALL ".join(selects)
            + f") AS _contracts ORDER BY _ord LIMIT {int(limit)}"
        )
        logger.debug("PG field contract query: %s", _truncate_sql(sql))
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall()
        elapsed = time.monotonic() - t0
        logger.info("PG field contracts done in %.2fs, %s violations", elapsed, len(rows))

        return [
            FieldContractViolation(
                field_name=str(row[0]),
                drift_type=str(row[1]),
                bad_count=int(row[2]),
                total_count=int(row[3]),
                threshold=float(row[4]),
                bad_rate=float(row[5]),
                sample_value=None if row[6] is None else str(row[6]),
            )
            for row in rows
        ]

    def get_full_breakdown(
        self,
        base_query: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None = None,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
        limit: int = 50000,
    ) -> tuple[list[str], list[str], list[str], list[tuple[object, ...]]]:
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}
        json_value_names: list[str] = []

        select_parts: list[str] = []
        group_parts: list[str] = []
        for c in reg_cols:
            select_parts.append(_quote_ident(c))
            group_parts.append(_quote_ident(c))
        for c in json_cols:
            expr = self._json_paths_expression(c)
            select_parts.append(f"{expr} AS {_quote_ident(c)}")
            group_parts.append(expr)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                value_expr = f"({self._json_path_expression(c, path)})::text"
                select_parts.append(f"{value_expr} AS {_quote_ident(full_path)}")
                group_parts.append(value_expr)
                json_value_names.append(full_path)
        select_parts.append("count(*) AS _cnt")

        group_by = ", ".join(group_parts) if group_parts else "()"
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY {group_by} "
            f"ORDER BY _cnt DESC "
            f"LIMIT {int(limit)}"
        )

        logger.debug("PG breakdown query: %s", _truncate_sql(sql))
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info("PG breakdown done in %.2fs, %s rows", elapsed, len(rows))

        return reg_cols, json_cols, json_value_names, rows

    def get_time_bucketed_counts(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        tc = self._validate_column(time_column)

        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}

        bucket_expr = self._bucket_expression(tc, interval)
        select_parts: list[str] = [f"{bucket_expr} AS _bucket"]
        group_parts: list[str] = ["_bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(_quote_ident(c))
            group_parts.append(_quote_ident(c))
            col_names.append(c)
        for c in json_cols:
            expr = self._json_paths_expression(c)
            select_parts.append(f"{expr} AS {_quote_ident(c)}")
            group_parts.append(expr)
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                value_expr = f"({self._json_path_expression(c, path)})::text"
                select_parts.append(f"{value_expr} AS {_quote_ident(full_path)}")
                group_parts.append(value_expr)
                json_value_names.append(full_path)
        select_parts.append("count(*) AS _cnt")

        window = self._time_window_condition(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {window} "
            f"GROUP BY {', '.join(group_parts)} "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.debug("PG bucketed query: %s", _truncate_sql(sql))
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info("PG bucketed done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, json_value_names, rows

    def _aggregate_value_sql(self, agg_fn: MetricAggregation, measure_column: str | None) -> str:
        """Validate + escape the measure and build the safe aggregate fragment."""
        measure_sql: str | None = None
        if measure_column is not None:
            measure_sql = _quote_ident(
                validate_measure_column(measure_column, self._allowed_columns)
            )
        return build_aggregate_sql(agg_fn, measure_sql)

    def get_time_bucketed_aggregate(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        agg_fn: MetricAggregation,
        measure_column: str | None,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        tc = self._validate_column(time_column)

        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}
        value_sql = self._aggregate_value_sql(agg_fn, measure_column)

        bucket_expr = self._bucket_expression(tc, interval)
        select_parts: list[str] = [f"{bucket_expr} AS _bucket"]
        group_parts: list[str] = ["_bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(_quote_ident(c))
            group_parts.append(_quote_ident(c))
            col_names.append(c)
        for c in json_cols:
            expr = self._json_paths_expression(c)
            select_parts.append(f"{expr} AS {_quote_ident(c)}")
            group_parts.append(expr)
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                value_expr = f"({self._json_path_expression(c, path)})::text"
                select_parts.append(f"{value_expr} AS {_quote_ident(full_path)}")
                group_parts.append(value_expr)
                json_value_names.append(full_path)
        select_parts.append(f"{value_sql} AS _value")

        window = self._time_window_condition(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {window} "
            f"GROUP BY {', '.join(group_parts)} "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.debug("PG bucketed aggregate query: %s", _truncate_sql(sql))
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info("PG bucketed aggregate done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, json_value_names, rows

    def _breakdown_value_exprs(
        self,
        base_query: str,
        time_column: str,
        breakdown: str,
        raw_expr: str,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None,
    ) -> tuple[str, str]:
        """Build the (breakdown_value, is_other) expressions with Other folding."""
        if values_limit is None:
            return raw_expr, "0"
        top_count = max(values_limit - 1, 0)
        top_values = self._top_breakdown_values_multi(
            base_query,
            time_column,
            [breakdown],
            time_from,
            time_to,
            top_count,
        ).get(breakdown, [])
        if not top_values:
            return "'Other'", "1"
        quoted = ", ".join(self._quote_string(v) for v in top_values)
        in_clause = f"{raw_expr} IN ({quoted})"
        breakdown_expr = f"CASE WHEN {in_clause} THEN {raw_expr} ELSE 'Other' END"
        is_other_expr = f"CASE WHEN {in_clause} THEN 0 ELSE 1 END"
        return breakdown_expr, is_other_expr

    def get_time_bucketed_aggregate_breakdown(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        agg_fn: MetricAggregation,
        measure_column: str | None,
        breakdown_column: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        tc = self._validate_column(time_column)

        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        breakdown = self._validate_column(breakdown_column)
        if breakdown not in reg_cols:
            msg = f"Breakdown column must be a scalar column: {breakdown}"
            raise ValueError(msg)
        json_value_paths = json_value_paths or {}
        value_sql = self._aggregate_value_sql(agg_fn, measure_column)

        raw_expr = self._string_value_expression(breakdown)
        breakdown_expr, is_other_expr = self._breakdown_value_exprs(
            base_query,
            time_column,
            breakdown,
            raw_expr,
            time_from,
            time_to,
            values_limit,
        )

        bucket_expr = self._bucket_expression(tc, interval)
        select_parts: list[str] = [
            f"{bucket_expr} AS _bucket",
            f"{breakdown_expr} AS _breakdown_value",
            f"{is_other_expr} AS _is_other",
        ]
        group_parts: list[str] = ["_bucket", "_breakdown_value", "_is_other"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(_quote_ident(c))
            group_parts.append(_quote_ident(c))
            col_names.append(c)
        for c in json_cols:
            expr = self._json_paths_expression(c)
            select_parts.append(f"{expr} AS {_quote_ident(c)}")
            group_parts.append(expr)
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                value_expr = f"({self._json_path_expression(c, path)})::text"
                select_parts.append(f"{value_expr} AS {_quote_ident(full_path)}")
                group_parts.append(value_expr)
                json_value_names.append(full_path)
        select_parts.append(f"{value_sql} AS _value")

        window = self._time_window_condition(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {window} "
            f"GROUP BY {', '.join(group_parts)} "
            f"ORDER BY _bucket, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.debug(
            "PG bucketed aggregate breakdown query for %s: %s", breakdown, _truncate_sql(sql)
        )
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info("PG bucketed aggregate breakdown done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, json_value_names, rows

    def _spec_aggregate_sql(self, spec: AggregateSpec) -> str:
        """Build one (optionally conditional) aggregate fragment for a spec.

        Reuses the single-aggregate validation/escaping path
        (``_aggregate_value_sql`` -> validate_measure_column + build_aggregate_sql)
        and, when ``filter_sql`` is set, wraps the aggregate as a Postgres
        ``FILTER (WHERE ...)`` conditional so specs with different filters can
        share one scan. Postgres supports ``FILTER`` on ``count(*)`` and
        ``count(DISTINCT col)`` alike, so no CASE fallback is needed.
        ``filter_sql`` is a pre-validated boolean fragment injected as-is, the
        same trust model as the single-metric row-filter path.

        ``count`` / ``count_distinct`` with a ``FILTER`` return 0 (not NULL) for
        a bucket whose rows never match ``cond``; the remaining aggregates
        (``avg`` / ``sum`` / ``min`` / ``max``) already return NULL there. The
        zero-returning counts are wrapped in ``NULLIF(..., 0)`` so such a bucket
        reads as absent, matching the per-metric path whose filtered scan emits
        no row at all for it (a 0 would otherwise render as a spurious data
        point instead of a gap).
        """
        base = self._aggregate_value_sql(spec.aggregation, spec.column)
        if not spec.filter_sql:
            return base
        filtered = f"{base} FILTER (WHERE {spec.filter_sql})"
        if coerce_aggregation(spec.aggregation) in (
            MetricAggregation.count,
            MetricAggregation.count_distinct,
        ):
            return f"NULLIF({filtered}, 0)"
        return filtered

    def get_time_bucketed_multi_aggregate(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        specs: list[AggregateSpec],
        time_from: datetime,
        time_to: datetime,
        *,
        limit: int = 100000,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        tc = self._validate_column(time_column)

        bucket_expr = self._bucket_expression(tc, interval)
        select_parts: list[str] = [f"{bucket_expr} AS _bucket"]
        col_names: list[str] = ["bucket"]
        for spec in specs:
            select_parts.append(f"{self._spec_aggregate_sql(spec)} AS {_quote_ident(spec.key)}")
            col_names.append(spec.key)

        window = self._time_window_condition(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {window} "
            f"GROUP BY _bucket "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.debug("PG bucketed multi-aggregate query: %s", _truncate_sql(sql))
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info("PG bucketed multi-aggregate done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, rows

    def get_time_bucketed_multi_aggregate_breakdown(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        breakdown_column: str,
        specs: list[AggregateSpec],
        time_from: datetime,
        time_to: datetime,
        *,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        tc = self._validate_column(time_column)

        breakdown = self._validate_column(breakdown_column)

        raw_expr = self._string_value_expression(breakdown)
        breakdown_expr, is_other_expr = self._breakdown_value_exprs(
            base_query,
            time_column,
            breakdown,
            raw_expr,
            time_from,
            time_to,
            values_limit,
        )

        bucket_expr = self._bucket_expression(tc, interval)
        select_parts: list[str] = [
            f"{bucket_expr} AS _bucket",
            f"{breakdown_expr} AS _breakdown_value",
            f"{is_other_expr} AS _is_other",
        ]
        col_names: list[str] = ["bucket", "breakdown_value", "is_other"]
        for spec in specs:
            select_parts.append(f"{self._spec_aggregate_sql(spec)} AS {_quote_ident(spec.key)}")
            col_names.append(spec.key)

        window = self._time_window_condition(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {window} "
            f"GROUP BY _bucket, _breakdown_value, _is_other "
            f"ORDER BY _bucket, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.debug(
            "PG bucketed multi-aggregate breakdown query for %s: %s",
            breakdown,
            _truncate_sql(sql),
        )
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info(
            "PG bucketed multi-aggregate breakdown done in %.2fs, %s rows", elapsed, len(rows)
        )

        return col_names, rows

    def get_time_bucketed_breakdown_counts(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        breakdown_column: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        col_names, json_value_names, rows = self.get_time_bucketed_breakdown_counts_multi(
            base_query,
            time_column,
            interval,
            [breakdown_column],
            regular_columns,
            json_columns,
            json_value_paths,
            time_from,
            time_to,
            values_limit=values_limit,
            limit=limit,
        )
        return col_names, json_value_names, [(row[0], row[2], row[3], *row[4:]) for row in rows]

    def _top_breakdown_values_multi(
        self,
        base_query: str,
        time_column: str,
        breakdown_columns: list[str],
        time_from: datetime,
        time_to: datetime,
        limit: int,
    ) -> dict[str, list[str]]:
        if limit <= 0 or not breakdown_columns:
            return {column: [] for column in breakdown_columns}

        tc = self._validate_column(time_column)
        cols = [self._validate_column(c) for c in breakdown_columns]
        window = self._time_window_condition(tc, time_from, time_to)

        prepared = [
            f'{self._string_value_expression(c)} AS "__bd_raw_{i}"' for i, c in enumerate(cols)
        ]
        # One GROUPING SETS scan: per column, GROUP BY that single label so
        # ROW_NUMBER ranks values within that column only.
        grouping_sets = ", ".join(f'("__bd_raw_{i}")' for i in range(len(cols)))
        label_branches = " ".join(
            f'WHEN GROUPING("__bd_raw_{i}") = 0 THEN {self._quote_string(c)}'
            for i, c in enumerate(cols)
        )
        value_branches = " ".join(
            f'WHEN GROUPING("__bd_raw_{i}") = 0 THEN "__bd_raw_{i}"' for i in range(len(cols))
        )

        sql = (
            "SELECT _breakdown_column, _breakdown_value FROM ("
            "SELECT _breakdown_column, _breakdown_value, "
            "ROW_NUMBER() OVER (PARTITION BY _breakdown_column ORDER BY _cnt DESC) AS rn "
            "FROM ("
            "SELECT "
            f"CASE {label_branches} ELSE '' END AS _breakdown_column, "
            f"CASE {value_branches} ELSE '' END AS _breakdown_value, "
            "count(*) AS _cnt "
            "FROM ("
            f"SELECT {', '.join(prepared)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {window}"
            ") AS _prepared "
            f"GROUP BY GROUPING SETS ({grouping_sets})"
            ") AS _scored"
            ") AS _ranked "
            f"WHERE rn <= {int(limit)}"
        )
        logger.debug("PG breakdown top-values query: %s", _truncate_sql(sql))
        top: dict[str, list[str]] = {c: [] for c in cols}
        with self._conn.cursor() as cur:
            cur.execute(sql)
            for column, value in cur.fetchall():
                top.setdefault(str(column), []).append(str(value))
        return top

    def get_time_bucketed_breakdown_counts_multi(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        breakdown_columns: list[str],
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        if not breakdown_columns:
            return [], [], []

        tc = self._validate_column(time_column)

        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        breakdown_cols = [self._validate_column(c) for c in breakdown_columns]
        invalid = [c for c in breakdown_cols if c not in reg_cols]
        if invalid:
            msg = f"Breakdown columns must be scalar columns: {', '.join(invalid)}"
            raise ValueError(msg)

        json_value_paths = json_value_paths or {}
        top_values_by_column: dict[str, list[str]] | None = None
        if values_limit is not None:
            top_count = max(values_limit - 1, 0)
            top_values_by_column = self._top_breakdown_values_multi(
                base_query,
                time_column,
                breakdown_cols,
                time_from,
                time_to,
                top_count,
            )

        bucket_expr = self._bucket_expression(tc, interval)
        prepared_parts: list[str] = [f"{bucket_expr} AS _bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            prepared_parts.append(f"{_quote_ident(c)} AS {_quote_ident(c)}")
            col_names.append(c)
        for c in json_cols:
            prepared_parts.append(f"{self._json_paths_expression(c)} AS {_quote_ident(c)}")
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                prepared_parts.append(
                    f"({self._json_path_expression(c, path)})::text AS {_quote_ident(full_path)}"
                )
                json_value_names.append(full_path)

        grouping_columns = [
            _quote_ident(name) for name in [*reg_cols, *json_cols, *json_value_names]
        ]
        label_when: list[str] = []
        value_when: list[str] = []
        other_when: list[str] = []
        grouping_sets: list[str] = []

        for idx, column in enumerate(breakdown_cols):
            raw_expr = self._string_value_expression(column)
            value_alias = f"__bd_value_{idx}"
            other_alias = f"__bd_other_{idx}"
            top_values = (
                None if top_values_by_column is None else top_values_by_column.get(column, [])
            )
            if top_values is None:
                breakdown_expr = raw_expr
                is_other_expr = "0"
            elif top_values:
                quoted = ", ".join(self._quote_string(v) for v in top_values)
                in_clause = f"{raw_expr} IN ({quoted})"
                breakdown_expr = f"CASE WHEN {in_clause} THEN {raw_expr} ELSE 'Other' END"
                is_other_expr = f"CASE WHEN {in_clause} THEN 0 ELSE 1 END"
            else:
                breakdown_expr = "'Other'"
                is_other_expr = "1"

            prepared_parts.append(f"{breakdown_expr} AS {_quote_ident(value_alias)}")
            prepared_parts.append(f"{is_other_expr} AS {_quote_ident(other_alias)}")
            grouping_check = f"GROUPING({_quote_ident(value_alias)}) = 0"
            label_when.append(f"WHEN {grouping_check} THEN {self._quote_string(column)}")
            value_when.append(f"WHEN {grouping_check} THEN {_quote_ident(value_alias)}::text")
            other_when.append(f"WHEN {grouping_check} THEN {_quote_ident(other_alias)}")
            grouping_sets.append(
                "("
                + ", ".join(
                    [
                        "_bucket",
                        _quote_ident(value_alias),
                        _quote_ident(other_alias),
                        *grouping_columns,
                    ]
                )
                + ")"
            )

        select_parts = [
            "_bucket",
            f"CASE {' '.join(label_when)} ELSE '' END AS _breakdown_column",
            f"CASE {' '.join(value_when)} ELSE '' END AS _breakdown_value",
            f"CASE {' '.join(other_when)} ELSE 0 END AS _is_other",
            *grouping_columns,
            "count(*) AS _cnt",
        ]

        window = self._time_window_condition(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            "FROM ("
            f"SELECT {', '.join(prepared_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {window}"
            ") AS _prepared "
            f"GROUP BY GROUPING SETS ({', '.join(grouping_sets)}) "
            "ORDER BY _bucket, _breakdown_column, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.debug(
            "PG bucketed breakdown GROUPING SETS query for %s: %s",
            ", ".join(breakdown_cols),
            _truncate_sql(sql),
        )
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info("PG bucketed breakdown done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, json_value_names, rows
