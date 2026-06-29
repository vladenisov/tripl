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
    BaseAdapter,
    ColumnInfo,
    SchemaColumn,
    SchemaTable,
)
from tripl.core.adapters.measure_validator import (
    build_aggregate_sql,
    validate_measure_column,
)
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

# Hard cap on catalog rows pulled for SQL-editor autocomplete.
_SCHEMA_ROW_LIMIT = 5000

# Wall-clock cap on the catalog introspection job so a hung BQ job can't block
# the worker thread forever. Scoped to schema introspection only.
_SCHEMA_QUERY_TIMEOUT_SECONDS = 30

# TIMESTAMP_BIN accepts MICROSECOND..DAY. Week is normalized to 7 DAY.
# Month is not BIN-able (variable width) so we route it to TIMESTAMP_TRUNC.
_BIN_UNITS = {"second", "minute", "hour", "day"}


class BigQueryAdapter(BaseAdapter):
    """BigQuery-backed warehouse adapter.

    Auth: service-account JSON stored in DataSource.password_encrypted
    (decrypted upstream and passed in as `credentials_json`). The host field
    holds the GCP project_id; database_name holds the default dataset_id used
    when base_query references a bare table name.

    Semantics mirror the ClickHouse adapter:
      - toStartOfInterval → TIMESTAMP_BIN (or TIMESTAMP_TRUNC for month)
      - JSONAllPaths      → JSON_KEYS (top-level keys only)
      - GROUPING SETS     → native syntax in BQ standard SQL
      - LIMIT n BY col    → ROW_NUMBER() OVER (PARTITION BY ...) wrapper
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

    def _validate_interval(self, ch_interval: str) -> tuple[int, str]:
        m = _INTERVAL_RE.match(ch_interval.strip())
        if not m:
            msg = f"Unsupported interval: {ch_interval!r}"
            raise ValueError(msg)
        count = int(m.group(1))
        unit = m.group(2).lower()
        if unit == "week":
            return count * 7, "day"
        return count, unit

    def _bucket_expression(self, time_column: str, ch_interval: str) -> str:
        count, unit = self._validate_interval(ch_interval)
        tc = self._validate_column(time_column)
        col = f"`{tc}`"
        if unit == "month":
            if count != 1:
                msg = "BigQuery: only '1 month' is supported for month bucketing"
                raise ValueError(msg)
            return f"TIMESTAMP_TRUNC({col}, MONTH)"
        if unit in _BIN_UNITS:
            return (
                f"TIMESTAMP_BIN(INTERVAL {count} {unit.upper()}, {col}, "
                "TIMESTAMP '1970-01-01 00:00:00+00')"
            )
        msg = f"Unsupported interval unit: {unit}"
        raise ValueError(msg)

    def _json_path_expression(self, column: str, path: str) -> str:
        parts = [part for part in path.split(".") if part]
        if not parts:
            raise ValueError(f"Invalid JSON path: {path}")
        if any(not _IDENTIFIER_PART_RE.match(part) for part in parts):
            raise ValueError(f"Unsupported JSON path: {path}")
        col = f"`{self._validate_column(column)}`"
        json_path = "$." + ".".join(parts)
        return f"JSON_QUERY({col}, '{json_path}')"

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
        if time_column is None or time_from is None or time_to is None:
            return ""
        tc = self._validate_column(time_column)
        t_from = time_from.strftime("%Y-%m-%d %H:%M:%S")
        t_to = time_to.strftime("%Y-%m-%d %H:%M:%S")
        return f" WHERE `{tc}` >= TIMESTAMP '{t_from}' AND `{tc}` < TIMESTAMP '{t_to}'"

    def _json_paths_expression(self, column: str) -> str:
        # JSON_KEYS returns top-level keys as an ARRAY<STRING>; sort for parity
        # with ClickHouse's `arraySort(JSONAllPaths(col))`.
        c = f"`{self._validate_column(column)}`"
        return f"(SELECT ARRAY_AGG(k ORDER BY k) FROM UNNEST(JSON_KEYS({c}, 1)) AS k)"

    def get_columns(self, base_query: str) -> list[ColumnInfo]:
        job = self._client.query(f"SELECT * FROM ({base_query}) AS _src LIMIT 0")
        schema = job.result().schema
        columns: list[ColumnInfo] = []
        for field in schema:
            columns.append(
                ColumnInfo(
                    name=field.name,
                    type_name=str(field.field_type),
                    is_nullable=str(field.mode).upper() != "REQUIRED",
                )
            )
        self._allowed_columns = {c.name for c in columns}
        return columns

    def get_schema_tables(self) -> list[SchemaTable]:
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
        ch_interval: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        tc = self._validate_column(time_column)
        bucket_expr = self._bucket_expression(time_column, ch_interval)
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

        t_from = time_from.strftime("%Y-%m-%d %H:%M:%S")
        t_to = time_to.strftime("%Y-%m-%d %H:%M:%S")
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE `{tc}` >= TIMESTAMP '{t_from}' AND `{tc}` < TIMESTAMP '{t_to}' "
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

    def get_time_bucketed_aggregate(
        self,
        base_query: str,
        time_column: str,
        ch_interval: str,
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
        bucket_expr = self._bucket_expression(time_column, ch_interval)
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

        t_from = time_from.strftime("%Y-%m-%d %H:%M:%S")
        t_to = time_to.strftime("%Y-%m-%d %H:%M:%S")
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE `{tc}` >= TIMESTAMP '{t_from}' AND `{tc}` < TIMESTAMP '{t_to}' "
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
        ch_interval: str,
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
        bucket_expr = self._bucket_expression(time_column, ch_interval)
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

        t_from = time_from.strftime("%Y-%m-%d %H:%M:%S")
        t_to = time_to.strftime("%Y-%m-%d %H:%M:%S")
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE `{tc}` >= TIMESTAMP '{t_from}' AND `{tc}` < TIMESTAMP '{t_to}' "
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

    def get_time_bucketed_breakdown_counts(
        self,
        base_query: str,
        time_column: str,
        ch_interval: str,
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
            ch_interval,
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
        t_from = time_from.strftime("%Y-%m-%d %H:%M:%S")
        t_to = time_to.strftime("%Y-%m-%d %H:%M:%S")

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
            f"FROM ({base_query}) AS _src "
            f"WHERE `{tc}` >= TIMESTAMP '{t_from}' AND `{tc}` < TIMESTAMP '{t_to}'"
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
        ch_interval: str,
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
        bucket_expr = self._bucket_expression(time_column, ch_interval)
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

        t_from = time_from.strftime("%Y-%m-%d %H:%M:%S")
        t_to = time_to.strftime("%Y-%m-%d %H:%M:%S")
        sql = (
            f"SELECT {', '.join(select_parts)} "
            "FROM ("
            f"SELECT {', '.join(prepared_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE `{tc}` >= TIMESTAMP '{t_from}' AND `{tc}` < TIMESTAMP '{t_to}'"
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
