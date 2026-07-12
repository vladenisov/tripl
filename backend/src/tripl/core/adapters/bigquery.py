from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime
from typing import cast

from google.cloud import bigquery
from google.oauth2 import service_account

from tripl.core.adapters.base import (
    AggregateSpec,
    BaseAdapter,
    ColumnInfo,
    SchemaColumn,
    SchemaTable,
)
from tripl.core.adapters.measure_validator import (
    build_aggregate_sql,
    coerce_aggregation,
    validate_measure_column,
)
from tripl.core.bucketing import EPOCH, format_utc_literal, to_utc
from tripl.core.intervals import IntervalUnit, get_interval
from tripl.core.warehouse_types import ComplexKind, TimeKind, classify_complex, classify_time
from tripl.models.domain_enums import MetricAggregation

logger = logging.getLogger(__name__)

_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")
_IDENTIFIER_PART_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_INTERVAL_RE = re.compile(r"^(\d+)\s+(second|minute|hour|day|week|month)s?$", re.IGNORECASE)
# GCP project ids allow letters/digits/hyphens; dataset ids allow
# letters/digits/underscores. Validate the model-derived identifiers before
# interpolating them into the catalog query as defense-in-depth.
_BQ_PROJECT_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9-]*$")
_BQ_DATASET_RE = re.compile(r"^[a-zA-Z0-9_]+$")
# Sane upper bound so a pathologically long identifier can't reach logs/SQL.
# This does not tighten the character class above; currently-valid ids still pass.
_BQ_IDENTIFIER_MAX_LEN = 1024

# Hard cap on catalog rows pulled for SQL-editor autocomplete. Kept generous and
# in line with the ClickHouse/Postgres adapters so a dataset with thousands of
# wide tables can't blow up the response.
_SCHEMA_ROW_LIMIT = 50000

# Wall-clock cap on the catalog introspection job so a hung BQ job can't block
# the worker thread forever. Scoped to schema introspection only.
_SCHEMA_QUERY_TIMEOUT_SECONDS = 30

# GoogleSQL keeps TIMESTAMP/DATETIME/DATE in separate type families, each with its
# own bucket + trunc functions. Applying the wrong family's function to a column is
# a hard query error, so the family is selected from the column's declared type.
# The same prefixes name the literal types (`TIMESTAMP '...'`, `DATETIME '...'`,
# `DATE '...'`), which is likewise a per-family choice: a TIMESTAMP literal cannot
# be compared against a DATETIME or DATE column.
_BUCKET_FN_PREFIX = {
    TimeKind.timestamp: "TIMESTAMP",
    TimeKind.datetime: "DATETIME",
    TimeKind.date: "DATE",
}

# Intervals finer than a day cannot be expressed against a DATE column.
_SUB_DAY_UNITS = (IntervalUnit.minute, IntervalUnit.hour)

# Literal renderings. TIMESTAMP carries the explicit `+00:00` offset that
# `bucketing.format_utc_literal` emits; DATETIME is a *zone-less* wall clock, so its
# literal must NOT carry an offset (BigQuery rejects one) and instead spells the UTC
# wall clock; DATE keeps the date part only.
_DATETIME_LITERAL_FMT = "%Y-%m-%d %H:%M:%S.%f"
_DATE_LITERAL_FMT = "%Y-%m-%d"

# How deep `JSON_KEYS` walks a JSON value when enumerating paths. ClickHouse's
# JSONAllPaths returns every nested leaf path, so a top-level-only enumeration would
# make the same document look different on each warehouse. There is no "unlimited"
# depth argument, so this is a bound: leaves below it are not discovered.
_JSON_PATH_MAX_DEPTH = 20

# BigQuery spells an array-valued field as mode=REPEATED rather than a distinct type.
_REPEATED_MODE = "REPEATED"


def _walk_struct_fields(
    fields: object,
    prefix: str,
    *,
    blocked: bool,
    out: dict[str, bool],
) -> None:
    """Recurse a RECORD's declared subfields, collecting dotted leaf paths.

    ``blocked`` propagates "this leaf sits underneath a repeated field", which makes
    plain dotted access illegal in GoogleSQL (``ARRAY<STRUCT<...>>`` has no fields —
    it needs UNNEST). Such leaves are still *enumerated* so they stay visible in
    discovery; they are flagged unaddressable and rejected loudly if selected.
    """
    for sub in cast("list[bigquery.SchemaField]", fields):
        name = str(sub.name)
        path = f"{prefix}{name}"
        is_repeated = str(sub.mode or "").upper() == _REPEATED_MODE
        is_struct = classify_complex(str(sub.field_type)) is ComplexKind.struct
        if is_struct and sub.fields:
            _walk_struct_fields(sub.fields, f"{path}.", blocked=blocked or is_repeated, out=out)
            continue
        # A repeated *leaf* is fine: `col`.`tags` is an ARRAY<STRING> value, and
        # TO_JSON_STRING renders it like the JSON array ClickHouse would return.
        out[path] = not blocked


def _declared_struct_paths(field: bigquery.SchemaField) -> dict[str, bool]:
    """The dotted leaf paths a STRUCT/RECORD column declares, path -> addressable.

    Unlike a JSON column, a STRUCT's paths come from the *schema*, not from the rows,
    so they are identical for every row and need no warehouse-side enumeration.
    """
    paths: dict[str, bool] = {}
    root_repeated = str(field.mode or "").upper() == _REPEATED_MODE
    _walk_struct_fields(field.fields, "", blocked=root_repeated, out=paths)
    return dict(sorted(paths.items()))


class BigQueryAdapter(BaseAdapter):
    """BigQuery-backed warehouse adapter.

    Auth: service-account JSON stored in DataSource.password_encrypted
    (decrypted upstream and passed in as `credentials_json`). The host field
    holds the GCP project_id; database_name holds the default dataset_id used
    when base_query references a bare table name.

    Semantics mirror the ClickHouse adapter:
      - toStartOfInterval → TIMESTAMP_BUCKET/DATETIME_BUCKET/DATE_BUCKET, and
                            *_TRUNC(..., WEEK(MONDAY)) for weeks
      - JSONAllPaths      → JSON_KEYS (nested leaf paths) for a JSON column, and the
                            declared field schema for a STRUCT/RECORD column
      - GROUPING SETS     → native syntax in BQ standard SQL
      - LIMIT n BY col    → ROW_NUMBER() OVER (PARTITION BY ...) wrapper

    Everything time-related is *type-directed*: the bucket function, the comparison
    literal and the very question of whether a column can be a time column at all are
    decided by the column's declared type (see ``_time_kind``), which the adapter
    introspects lazily on first use.
    """

    def __init__(
        self,
        host: str,
        port: int,  # unused for BQ
        database: str,
        username: str = "",  # unused for BQ
        password: str = "",  # service-account JSON
        **kwargs: object,
    ) -> None:
        del port, username  # not applicable to BigQuery
        if not host:
            raise ValueError("BigQuery: host (project_id) is required")
        if not password:
            raise ValueError("BigQuery: service-account JSON credentials are required")
        try:
            info = cast(dict[str, object], json.loads(password))
        except json.JSONDecodeError as exc:
            raise ValueError(f"BigQuery: invalid service-account JSON: {exc}") from exc
        creds = cast(
            service_account.Credentials,
            service_account.Credentials.from_service_account_info(info),  # type: ignore[no-untyped-call]
        )
        raw_location = kwargs.get("location")
        location = raw_location if isinstance(raw_location, str) else None
        self._client = bigquery.Client(
            project=host,
            credentials=creds,
            location=location,
            default_query_job_config=bigquery.QueryJobConfig(
                default_dataset=f"{host}.{database}" if database else None,
            ),
        )
        self._project = host
        self._dataset = database
        self._allowed_columns: set[str] = set()
        # Declared type per column, captured during get_columns. The bucket and
        # time-window SQL are type-directed (TIMESTAMP vs DATETIME vs DATE), so the
        # adapter has to remember what the warehouse actually said.
        self._column_types: dict[str, str] = {}
        # Declared leaf paths per STRUCT/RECORD column (path -> addressable). A
        # STRUCT's paths come from the schema, not the data, so they are captured
        # alongside the types instead of being enumerated by a query.
        self._struct_paths: dict[str, dict[str, bool]] = {}

    def close(self) -> None:
        self._client.close()  # type: ignore[no-untyped-call]

    def test_connection(self) -> bool:
        job = self._client.query("SELECT 1 AS ok")
        row = next(iter(job.result()))
        return bool(row["ok"] == 1)

    def _validate_column(self, column: str) -> str:
        if not _IDENTIFIER_RE.match(column):
            msg = f"Invalid column name: {column}"
            raise ValueError(msg)
        if self._allowed_columns and column not in self._allowed_columns:
            msg = f"Column {column!r} not found in query result"
            raise ValueError(msg)
        return column

    def _bucket_expression(self, time_column: str, interval_code: str) -> str:
        """Translate an interval code into GoogleSQL bucket SQL.

        Must agree with ``tripl.core.bucketing.floor_to_bucket``.

        The bucket function is chosen by the column's *declared* type, not assumed:
        GoogleSQL keeps TIMESTAMP (an instant) and DATETIME (a zone-less wall
        clock) in separate type families and rejects a TIMESTAMP_* function applied
        to a DATETIME column. DATE has no time-of-day, so a sub-day interval on a
        DATE column is a configuration error rather than something to silently round.

        Weeks use ``*_TRUNC(..., WEEK(MONDAY))``: a 7-day ``*_BUCKET`` bins off the
        function's origin, and the contract says weeks start on Monday.

        The bucket origin is passed *explicitly* as the Unix epoch. GoogleSQL's
        ``*_BUCKET`` default origin is 1950-01-01, not the epoch; that happens to be a
        whole number of days away from the epoch (7305), so every sub-day interval
        would land on the same boundaries anyway — but the contract anchors at the
        epoch, so say so rather than relying on a coincidence.
        """
        spec = get_interval(interval_code)
        kind = self._time_kind(time_column)
        col = f"`{self._validate_column(time_column)}`"
        prefix = _BUCKET_FN_PREFIX[kind]

        if spec.unit is IntervalUnit.week:
            # TIMESTAMP_TRUNC takes a timezone; DATETIME/DATE are zone-less and do
            # not. Pin TIMESTAMP to UTC so a non-UTC project default cannot shift the
            # week boundary.
            zone = ", 'UTC'" if kind is TimeKind.timestamp else ""
            return f"{prefix}_TRUNC({col}, WEEK(MONDAY){zone})"
        if kind is TimeKind.date and spec.unit in _SUB_DAY_UNITS:
            msg = (
                f"BigQuery: time column {time_column!r} is a DATE, which has no "
                f"time-of-day, so it cannot be bucketed at {interval_code!r}. "
                "Use the 1d or 1w interval, or a TIMESTAMP/DATETIME column."
            )
            raise ValueError(msg)
        origin = self._time_literal(kind, EPOCH)
        width = f"INTERVAL {spec.count} {spec.unit.value.upper()}"
        return f"{prefix}_BUCKET({col}, {width}, {origin})"

    def _time_literal(self, kind: TimeKind, value: datetime) -> str:
        """Render a UTC datetime as a literal comparable against a ``kind`` column.

        The literal *type* has to match the column's type family: GoogleSQL will not
        compare a ``TIMESTAMP`` literal against a ``DATETIME`` or ``DATE`` column, so
        emitting ``TIMESTAMP '...'`` everywhere is a hard query error on two of the
        three supported column types.

        Everything is normalized to UTC first (``to_utc``). ``strftime`` on an aware
        non-UTC datetime silently drops the offset and writes the wrong wall clock,
        which is exactly how a window ends up shifted by hours without failing.

        For a DATE column the window bound is floored to its UTC day. The window stays
        half-open (``>= from_day``, ``< to_day``), so adjacent windows still tile; on
        the 1d/1w intervals a DATE column supports, the bounds are day-aligned anyway
        and the flooring is exact.
        """
        moment = to_utc(value)
        if kind is TimeKind.timestamp:
            return f"TIMESTAMP '{format_utc_literal(moment)}'"
        if kind is TimeKind.datetime:
            return f"DATETIME '{moment.strftime(_DATETIME_LITERAL_FMT)}'"
        if kind is TimeKind.date:
            return f"DATE '{moment.strftime(_DATE_LITERAL_FMT)}'"
        msg = f"BigQuery: cannot build a time literal for {kind.value!r}"
        raise ValueError(msg)

    def _complex_kind(self, column: str) -> ComplexKind:
        """How a nested column must be addressed: a JSON document or a STRUCT.

        Falls back to JSON when the column's type was never introspected, preserving
        the behavior of callers that reach a JSON path without a preceding
        ``get_columns``.
        """
        type_name = self._column_types.get(column)
        if type_name is None:
            return ComplexKind.json
        kind = classify_complex(type_name)
        if kind is None:
            msg = (
                f"BigQuery: column {column!r} has scalar type {type_name} and holds no "
                "nested paths. Only JSON and STRUCT/RECORD columns can be path-expanded."
            )
            raise ValueError(msg)
        if kind is ComplexKind.map:
            msg = f"BigQuery: column {column!r} has unsupported nested type {type_name}."
            raise ValueError(msg)
        return kind

    def _struct_field_expression(self, column: str, parts: list[str]) -> str:
        """Address a leaf of a STRUCT/RECORD column with dotted field access.

        A STRUCT is *not* a JSON document: ``JSON_QUERY`` does not apply to it, and its
        legal paths are exactly the ones the schema declares. A path that is not
        declared — or one buried under a repeated field, which GoogleSQL can only reach
        through UNNEST — is rejected here rather than compiled into SQL that either
        fails opaquely in a worker or silently drops the field.
        """
        declared = self._struct_paths.get(column, {})
        path = ".".join(parts)
        addressable = declared.get(path)
        if addressable is None:
            known = ", ".join(declared) or "<none>"
            msg = (
                f"BigQuery: {path!r} is not a declared field of STRUCT column "
                f"{column!r}. Known paths: {known}"
            )
            raise ValueError(msg)
        if not addressable:
            msg = (
                f"BigQuery: STRUCT path {column}.{path} is nested inside a repeated "
                "(ARRAY) field. GoogleSQL cannot address it with dotted field access — "
                "it needs UNNEST, which this adapter does not generate. Select a path "
                "outside the repeated field."
            )
            raise ValueError(msg)
        fields = "".join(f".`{part}`" for part in parts)
        return f"`{column}`{fields}"

    def _json_path_expression(self, column: str, path: str) -> str:
        parts = [part for part in path.split(".") if part]
        if not parts:
            raise ValueError(f"Invalid JSON path: {path}")
        if any(not _IDENTIFIER_PART_RE.match(part) for part in parts):
            raise ValueError(f"Unsupported JSON path: {path}")
        col = self._validate_column(column)
        if self._complex_kind(col) is ComplexKind.struct:
            return self._struct_field_expression(col, parts)
        json_path = "$." + ".".join(parts)
        return f"JSON_QUERY(`{col}`, '{json_path}')"

    def _string_value_expression(self, column: str) -> str:
        return f"IFNULL(CAST(`{self._validate_column(column)}` AS STRING), '')"

    def _quote_string(self, value: str) -> str:
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

    def _time_window_where_clause(
        self,
        time_column: str | None,
        time_from: datetime | None,
        time_to: datetime | None,
    ) -> str:
        """The half-open ``[time_from, time_to)`` predicate, or ``""`` if unbounded.

        The single place a time window becomes SQL: every read path routes through it,
        so the literal type follows the column's type family and the UTC normalization
        happens exactly once. Callers with a mandatory window pass non-None values and
        always get a clause back.
        """
        if time_column is None or time_from is None or time_to is None:
            return ""
        tc = self._validate_column(time_column)
        kind = self._time_kind(time_column)
        lower = self._time_literal(kind, time_from)
        upper = self._time_literal(kind, time_to)
        return f" WHERE `{tc}` >= {lower} AND `{tc}` < {upper}"

    def _json_paths_expression(self, column: str) -> str:
        """The sorted ARRAY<STRING> of nested leaf paths held by a nested column.

        Mirrors ClickHouse's ``arraySort(JSONAllPaths(col))``, whose elements are the
        *leaf* paths of the document (``user.address.city``), not its top-level keys.
        BigQuery's ``JSON_KEYS(col, depth)`` returns every key down to ``depth``,
        interior ones included, so an interior key is dropped by keeping only the keys
        that no other key extends with a ``.`` — what is left is the leaf set.

        A STRUCT column has no data-dependent shape: its paths are declared by the
        schema and identical for every row, so they are emitted as an array literal
        rather than computed per row.
        """
        col = self._validate_column(column)
        if self._complex_kind(col) is ComplexKind.struct:
            paths = self._struct_paths.get(col, {})
            if not paths:
                return "ARRAY<STRING>[]"
            return "[" + ", ".join(self._quote_string(path) for path in paths) + "]"
        keys = f"JSON_KEYS(`{col}`, {_JSON_PATH_MAX_DEPTH})"
        return (
            f"(SELECT ARRAY_AGG(_path ORDER BY _path) FROM UNNEST({keys}) AS _path "
            f"WHERE NOT EXISTS("
            f"SELECT 1 FROM UNNEST({keys}) AS _child "
            f"WHERE STARTS_WITH(_child, CONCAT(_path, '.'))))"
        )

    def get_columns(self, base_query: str) -> list[ColumnInfo]:
        job = self._client.query(f"SELECT * FROM ({base_query}) AS _src LIMIT 0")
        schema = job.result().schema
        columns: list[ColumnInfo] = []
        struct_paths: dict[str, dict[str, bool]] = {}
        for field in schema:
            type_name = str(field.field_type)
            columns.append(
                ColumnInfo(
                    name=field.name,
                    type_name=type_name,
                    is_nullable=str(field.mode).upper() != "REQUIRED",
                )
            )
            if classify_complex(type_name) is ComplexKind.struct:
                struct_paths[str(field.name)] = _declared_struct_paths(field)
        self._allowed_columns = {c.name for c in columns}
        self._column_types = {c.name: c.type_name for c in columns}
        self._struct_paths = struct_paths
        return columns

    def _ensure_column_types(self, base_query: str) -> None:
        """Introspect the source's schema once, before generating type-directed SQL.

        The bucket function, the window literal and the nested-path expansion are all
        chosen from the column's declared type, and a metric/preview caller builds a
        fresh adapter and jumps straight to a read — nothing calls ``get_columns``
        first. Guessing TIMESTAMP there is what produced invalid SQL against DATETIME
        and DATE columns, so pay for one ``LIMIT 0`` schema job per adapter instead.
        """
        if not self._column_types:
            self.get_columns(base_query)

    def _time_kind(self, time_column: str) -> TimeKind:
        """Resolve the declared time-type family of a configured time column.

        Raises for a column that carries no date (BigQuery ``TIME``). Every read path
        runs ``_ensure_column_types`` first, so this fires while the caller is still
        configuring/previewing a metric, not several layers deep inside a worker.

        Falls back to TIMESTAMP only when the column's type was never introspected —
        callers that reach the bucket path without a preceding ``get_columns`` are
        exercising the pre-existing TIMESTAMP-only behavior.
        """
        type_name = self._column_types.get(time_column)
        if type_name is None:
            return TimeKind.timestamp
        kind = classify_time(type_name)
        if kind is TimeKind.unsupported:
            msg = (
                f"BigQuery: time column {time_column!r} has type {type_name}, which "
                "carries no date and cannot be used as a time column. "
                "Use a TIMESTAMP, DATETIME or DATE column."
            )
            raise ValueError(msg)
        return kind

    def get_schema_tables(self) -> list[SchemaTable]:
        # Unlike ClickHouse/Postgres, this stays scoped to the connection's
        # default dataset and returns every table BARE. BigQuery's
        # INFORMATION_SCHEMA.COLUMNS view is dataset-qualified, so covering every
        # dataset would mean either listing datasets and issuing one job per
        # dataset (N extra round-trips / billed jobs) or a region-qualified
        # `region-<location>` view that requires the connection's location to be
        # known and correct. Both are expensive/fragile for autocomplete, so we
        # deliberately keep the single-dataset scan and leave cross-dataset
        # qualification (`dataset.table`) to a future change if it proves needed.
        #
        # project/dataset come only from the validated DataSource model, never
        # from a request; still validate before interpolating into the query.
        if len(self._project) > _BQ_IDENTIFIER_MAX_LEN or not _BQ_PROJECT_RE.match(self._project):
            raise ValueError(f"Invalid BigQuery project id: {self._project!r}")
        if len(self._dataset) > _BQ_IDENTIFIER_MAX_LEN or not _BQ_DATASET_RE.match(self._dataset):
            raise ValueError(f"Invalid BigQuery dataset id: {self._dataset!r}")
        sql = (
            "SELECT table_name, column_name, data_type "
            f"FROM `{self._project}.{self._dataset}.INFORMATION_SCHEMA.COLUMNS` "
            f"ORDER BY table_name, ordinal_position LIMIT {_SCHEMA_ROW_LIMIT}"
        )
        logger.debug("BQ schema introspection query: %s", sql)
        _, rows = self._query_rows(sql, timeout=_SCHEMA_QUERY_TIMEOUT_SECONDS)
        columns_by_table: dict[str, list[SchemaColumn]] = {}
        for table_name, column_name, data_type in rows:
            columns_by_table.setdefault(str(table_name), []).append(
                SchemaColumn(name=str(column_name), data_type=str(data_type))
            )
        return [
            SchemaTable(name=table, columns=columns) for table, columns in columns_by_table.items()
        ]

    def _query_rows(
        self, sql: str, *, timeout: float | None = None
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        job = self._client.query(sql)
        iterator = job.result() if timeout is None else job.result(timeout=timeout)
        names = [field.name for field in iterator.schema]
        rows = [tuple(row.values()) for row in iterator]
        return names, rows

    def get_preview_rows(
        self,
        base_query: str,
        limit: int = 10,
        *,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        if time_column is not None:
            # A preview is where a metric's time column gets chosen, so this is where
            # an unusable one (TIME) must fail — and where a DATETIME/DATE one has to
            # be recognized so the window literal matches it.
            self._ensure_column_types(base_query)
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        sql = f"SELECT * FROM ({base_query}) AS _src{where_clause} LIMIT {int(limit)}"
        logger.info("BQ preview query: %s", sql)
        return self._query_rows(sql)

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
        self._ensure_column_types(base_query)
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}
        json_value_names: list[str] = []

        select_parts: list[str] = []
        group_parts: list[str] = []
        for c in reg_cols:
            select_parts.append(f"`{c}`")
            group_parts.append(f"`{c}`")
        for c in json_cols:
            expr = self._json_paths_expression(c)
            select_parts.append(f"{expr} AS `{c}`")
            group_parts.append(expr)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                value_expr = f"TO_JSON_STRING({self._json_path_expression(c, path)})"
                select_parts.append(f"{value_expr} AS `{full_path}`")
                group_parts.append(value_expr)
                json_value_names.append(full_path)
        select_parts.append("COUNT(*) AS _cnt")

        group_by = ", ".join(group_parts) if group_parts else "()"
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY {group_by} "
            f"ORDER BY _cnt DESC "
            f"LIMIT {int(limit)}"
        )

        short = sql[:300] + ("..." if len(sql) > 300 else "")
        logger.info("BQ breakdown query: %s", short)
        t0 = time.monotonic()
        _, rows = self._query_rows(sql)
        elapsed = time.monotonic() - t0
        logger.info("BQ breakdown done in %.2fs, %s rows", elapsed, len(rows))

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
        self._ensure_column_types(base_query)
        bucket_expr = self._bucket_expression(time_column, interval)
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}

        select_parts: list[str] = [f"{bucket_expr} AS _bucket"]
        group_parts: list[str] = ["_bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(f"`{c}`")
            group_parts.append(f"`{c}`")
            col_names.append(c)
        for c in json_cols:
            expr = self._json_paths_expression(c)
            select_parts.append(f"{expr} AS `{c}`")
            group_parts.append(expr)
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                value_expr = f"TO_JSON_STRING({self._json_path_expression(c, path)})"
                select_parts.append(f"{value_expr} AS `{full_path}`")
                group_parts.append(value_expr)
                json_value_names.append(full_path)
        select_parts.append("COUNT(*) AS _cnt")

        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY {', '.join(group_parts)} "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.info("BQ bucketed query: %s", sql)
        t0 = time.monotonic()
        _, rows = self._query_rows(sql)
        elapsed = time.monotonic() - t0
        logger.info("BQ bucketed done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, json_value_names, rows

    def _aggregate_value_sql(self, agg_fn: MetricAggregation, measure_column: str | None) -> str:
        """Validate + escape the measure and build the safe aggregate fragment."""
        measure_sql: str | None = None
        if measure_column is not None:
            measure_sql = f"`{validate_measure_column(measure_column, self._allowed_columns)}`"
        return build_aggregate_sql(agg_fn, measure_sql)

    def _validate_alias(self, alias: str) -> str:
        """Validate a caller-supplied output column alias before interpolation."""
        if not _IDENTIFIER_PART_RE.match(alias):
            msg = f"Invalid aggregate key alias: {alias!r}"
            raise ValueError(msg)
        return alias

    def _conditional_aggregate_sql(self, spec: AggregateSpec) -> str:
        """Build one (optionally conditional) aggregate fragment for a spec.

        With no ``filter_sql`` this reuses the exact single-aggregate fragment
        (``build_aggregate_sql``) so values match the per-metric path. With a
        filter, BigQuery lacks the ``FILTER (WHERE ...)`` clause, so the
        condition is folded into the aggregate per the dialect rules:
        ``count`` -> ``count(CASE WHEN cond THEN 1 END)``; ``count_distinct`` ->
        ``count(DISTINCT IF(cond, col, NULL))``; ``sum/avg/min/max`` ->
        ``agg(CASE WHEN cond THEN col END)``. ``filter_sql`` is a pre-validated
        boolean fragment injected as-is, matching the row-filter trust model.

        ``count`` / ``count_distinct`` return 0 (not NULL) for a bucket whose
        rows never match ``cond``; ``avg`` / ``sum`` / ``min`` / ``max`` over the
        ``CASE WHEN`` form already return NULL there. The zero-returning counts
        are wrapped in ``NULLIF(..., 0)`` so such a bucket reads as absent,
        matching the per-metric path whose filtered scan emits no row at all for
        it (a 0 would otherwise render as a spurious data point instead of a gap).
        """
        measure_sql: str | None = None
        if spec.column is not None:
            measure_sql = f"`{validate_measure_column(spec.column, self._allowed_columns)}`"
        agg = coerce_aggregation(spec.aggregation)
        if spec.filter_sql is None:
            return build_aggregate_sql(agg, measure_sql)
        cond = spec.filter_sql
        if agg is MetricAggregation.count:
            return f"NULLIF(count(CASE WHEN {cond} THEN 1 END), 0)"
        if not measure_sql:
            msg = f"Aggregation {agg.value!r} requires a measure column"
            raise ValueError(msg)
        if agg is MetricAggregation.count_distinct:
            return f"NULLIF(count(DISTINCT IF({cond}, {measure_sql}, NULL)), 0)"
        return f"{agg.value}(CASE WHEN {cond} THEN {measure_sql} END)"

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
        self._ensure_column_types(base_query)
        bucket_expr = self._bucket_expression(time_column, interval)
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}
        value_sql = self._aggregate_value_sql(agg_fn, measure_column)

        select_parts: list[str] = [f"{bucket_expr} AS _bucket"]
        group_parts: list[str] = ["_bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(f"`{c}`")
            group_parts.append(f"`{c}`")
            col_names.append(c)
        for c in json_cols:
            expr = self._json_paths_expression(c)
            select_parts.append(f"{expr} AS `{c}`")
            group_parts.append(expr)
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                value_expr = f"TO_JSON_STRING({self._json_path_expression(c, path)})"
                select_parts.append(f"{value_expr} AS `{full_path}`")
                group_parts.append(value_expr)
                json_value_names.append(full_path)
        select_parts.append(f"{value_sql} AS _value")

        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY {', '.join(group_parts)} "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.info("BQ bucketed aggregate query: %s", sql)
        t0 = time.monotonic()
        _, rows = self._query_rows(sql)
        elapsed = time.monotonic() - t0
        logger.info("BQ bucketed aggregate done in %.2fs, %s rows", elapsed, len(rows))

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
        self._ensure_column_types(base_query)
        bucket_expr = self._bucket_expression(time_column, interval)
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
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

        select_parts: list[str] = [
            f"{bucket_expr} AS _bucket",
            f"{breakdown_expr} AS _breakdown_value",
            f"{is_other_expr} AS _is_other",
        ]
        group_parts: list[str] = ["_bucket", "_breakdown_value", "_is_other"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(f"`{c}`")
            group_parts.append(f"`{c}`")
            col_names.append(c)
        for c in json_cols:
            expr = self._json_paths_expression(c)
            select_parts.append(f"{expr} AS `{c}`")
            group_parts.append(expr)
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                value_expr = f"TO_JSON_STRING({self._json_path_expression(c, path)})"
                select_parts.append(f"{value_expr} AS `{full_path}`")
                group_parts.append(value_expr)
                json_value_names.append(full_path)
        select_parts.append(f"{value_sql} AS _value")

        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY {', '.join(group_parts)} "
            f"ORDER BY _bucket, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.info("BQ bucketed aggregate breakdown query for %s: %s", breakdown, sql)
        t0 = time.monotonic()
        _, rows = self._query_rows(sql)
        elapsed = time.monotonic() - t0
        logger.info("BQ bucketed aggregate breakdown done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, json_value_names, rows

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
        self._ensure_column_types(base_query)
        bucket_expr = self._bucket_expression(time_column, interval)
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        if not specs:
            return ["bucket"], []

        select_parts: list[str] = [f"{bucket_expr} AS _bucket"]
        column_names: list[str] = ["bucket"]
        for spec in specs:
            key = self._validate_alias(spec.key)
            select_parts.append(f"{self._conditional_aggregate_sql(spec)} AS `{key}`")
            column_names.append(spec.key)

        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY _bucket "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.info("BQ bucketed multi-aggregate query: %s", sql)
        t0 = time.monotonic()
        _, rows = self._query_rows(sql)
        elapsed = time.monotonic() - t0
        logger.info("BQ bucketed multi-aggregate done in %.2fs, %s rows", elapsed, len(rows))

        return column_names, rows

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
        self._ensure_column_types(base_query)
        bucket_expr = self._bucket_expression(time_column, interval)
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        breakdown = self._validate_column(breakdown_column)
        if not specs:
            return ["bucket", "breakdown_value", "is_other"], []

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

        select_parts: list[str] = [
            f"{bucket_expr} AS _bucket",
            f"{breakdown_expr} AS _breakdown_value",
            f"{is_other_expr} AS _is_other",
        ]
        column_names: list[str] = ["bucket", "breakdown_value", "is_other"]
        for spec in specs:
            key = self._validate_alias(spec.key)
            select_parts.append(f"{self._conditional_aggregate_sql(spec)} AS `{key}`")
            column_names.append(spec.key)

        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY _bucket, _breakdown_value, _is_other "
            f"ORDER BY _bucket, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.info("BQ bucketed multi-aggregate breakdown query for %s: %s", breakdown, sql)
        t0 = time.monotonic()
        _, rows = self._query_rows(sql)
        elapsed = time.monotonic() - t0
        logger.info(
            "BQ bucketed multi-aggregate breakdown done in %.2fs, %s rows", elapsed, len(rows)
        )

        return column_names, rows

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

        self._ensure_column_types(base_query)
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        cols = [self._validate_column(c) for c in breakdown_columns]

        prepared = [
            f"{self._string_value_expression(c)} AS `__bd_raw_{i}`" for i, c in enumerate(cols)
        ]
        grouping_sets = ", ".join(f"(`__bd_raw_{i}`)" for i in range(len(cols)))
        label_branches = " ".join(
            f"WHEN GROUPING(`__bd_raw_{i}`) = 0 THEN {self._quote_string(c)}"
            for i, c in enumerate(cols)
        )
        value_branches = " ".join(
            f"WHEN GROUPING(`__bd_raw_{i}`) = 0 THEN `__bd_raw_{i}`" for i in range(len(cols))
        )

        sql = (
            "SELECT _breakdown_column, _breakdown_value FROM ("
            "SELECT _breakdown_column, _breakdown_value, "
            "ROW_NUMBER() OVER (PARTITION BY _breakdown_column ORDER BY _cnt DESC) AS rn "
            "FROM ("
            "SELECT "
            f"CASE {label_branches} ELSE '' END AS _breakdown_column, "
            f"CASE {value_branches} ELSE '' END AS _breakdown_value, "
            "COUNT(*) AS _cnt "
            "FROM ("
            f"SELECT {', '.join(prepared)} "
            f"FROM ({base_query}) AS _src{where_clause}"
            ") AS _prepared "
            f"GROUP BY GROUPING SETS ({grouping_sets})"
            ") AS _scored"
            ") AS _ranked "
            f"WHERE rn <= {int(limit)}"
        )
        logger.info("BQ breakdown top-values query: %s", sql)
        top: dict[str, list[str]] = {c: [] for c in cols}
        _, rows = self._query_rows(sql)
        for column, value in rows:
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

        self._ensure_column_types(base_query)
        bucket_expr = self._bucket_expression(time_column, interval)
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
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

        prepared_parts: list[str] = [f"{bucket_expr} AS _bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            prepared_parts.append(f"`{c}` AS `{c}`")
            col_names.append(c)
        for c in json_cols:
            prepared_parts.append(f"{self._json_paths_expression(c)} AS `{c}`")
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                prepared_parts.append(
                    f"TO_JSON_STRING({self._json_path_expression(c, path)}) AS `{full_path}`"
                )
                json_value_names.append(full_path)

        grouping_columns = [f"`{name}`" for name in [*reg_cols, *json_cols, *json_value_names]]
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

            prepared_parts.append(f"{breakdown_expr} AS `{value_alias}`")
            prepared_parts.append(f"{is_other_expr} AS `{other_alias}`")
            grouping_check = f"GROUPING(`{value_alias}`) = 0"
            label_when.append(f"WHEN {grouping_check} THEN {self._quote_string(column)}")
            value_when.append(f"WHEN {grouping_check} THEN CAST(`{value_alias}` AS STRING)")
            other_when.append(f"WHEN {grouping_check} THEN `{other_alias}`")
            grouping_sets.append(
                "("
                + ", ".join(
                    [
                        "_bucket",
                        f"`{value_alias}`",
                        f"`{other_alias}`",
                        *grouping_columns,
                    ]
                )
                + ")"
            )

        select_parts: list[str] = [
            "_bucket",
            f"CASE {' '.join(label_when)} ELSE '' END AS _breakdown_column",
            f"CASE {' '.join(value_when)} ELSE '' END AS _breakdown_value",
            f"CASE {' '.join(other_when)} ELSE 0 END AS _is_other",
            *grouping_columns,
            "COUNT(*) AS _cnt",
        ]

        sql = (
            f"SELECT {', '.join(select_parts)} "
            "FROM ("
            f"SELECT {', '.join(prepared_parts)} "
            f"FROM ({base_query}) AS _src{where_clause}"
            ") AS _prepared "
            f"GROUP BY GROUPING SETS ({', '.join(grouping_sets)}) "
            "ORDER BY _bucket, _breakdown_column, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.info(
            "BQ bucketed breakdown GROUPING SETS query for %s: %s",
            ", ".join(breakdown_cols),
            sql,
        )
        t0 = time.monotonic()
        _, rows = self._query_rows(sql)
        elapsed = time.monotonic() - t0
        logger.info("BQ bucketed breakdown done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, json_value_names, rows
