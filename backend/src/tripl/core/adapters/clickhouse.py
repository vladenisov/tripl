from __future__ import annotations

import logging
import re
import time
from datetime import datetime
from typing import override

import clickhouse_connect  # type: ignore[import-untyped]

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
from tripl.core.bucketing import format_utc_literal
from tripl.core.intervals import IntervalUnit, get_interval
from tripl.models.domain_enums import MetricAggregation

# Hard cap on rows pulled from the catalog so a warehouse with thousands of
# wide tables can't blow up the autocomplete payload or the request. The cap is
# generous because introspection now spans every non-system database (one row
# per column per table across all of them), so a multi-database warehouse needs
# plenty of headroom before its visible tables get truncated.
_SCHEMA_ROW_LIMIT = 50000

# System databases that hold ClickHouse internals, not user data. They are
# excluded from catalog introspection so autocomplete only surfaces queryable
# user tables. ClickHouse exposes both `information_schema` and its uppercase
# alias `INFORMATION_SCHEMA`; exclude both.
_SYSTEM_DATABASES = ("system", "information_schema", "INFORMATION_SCHEMA")

logger = logging.getLogger(__name__)

_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")
_IDENTIFIER_PART_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

# JSON path *discovery* (preview) enumeration functions. "dynamic" lists only the
# important typed subcolumn paths (fast); "all" lists every path incl. shared-data
# paths. Scan-time value extraction always uses JSONAllPaths and is unaffected.
_JSON_PATH_DISCOVERY_FUNCS = {"all": "JSONAllPaths", "dynamic": "JSONDynamicPaths"}
_DEFAULT_JSON_PATH_DISCOVERY = "dynamic"


class ClickHouseAdapter(BaseAdapter):
    def __init__(
        self,
        host: str,
        port: int,
        database: str,
        username: str = "",
        password: str = "",
        json_path_discovery: str | None = None,
        **kwargs: object,
    ) -> None:
        self._client = clickhouse_connect.get_client(
            host=host,
            port=port,
            database=database,
            username=username or "default",
            password=password or "",
            **kwargs,
        )
        self._allowed_columns: set[str] = set()
        # Which path-enumeration function the JSON path discovery query uses.
        # Unknown/None falls back to the default ("dynamic").
        self._json_path_discovery = (
            json_path_discovery
            if json_path_discovery in _JSON_PATH_DISCOVERY_FUNCS
            else _DEFAULT_JSON_PATH_DISCOVERY
        )

    def close(self) -> None:
        self._client.close()

    def test_connection(self) -> bool:
        result = self._client.query("SELECT 1")
        return bool(result.first_row[0] == 1)

    def get_columns(self, base_query: str) -> list[ColumnInfo]:
        result = self._client.query(f"SELECT * FROM ({base_query}) AS _src LIMIT 0")
        columns: list[ColumnInfo] = []
        for name, type_info in zip(result.column_names, result.column_types, strict=False):
            # clickhouse-connect type objects render their object repr under
            # str() (e.g. "<...Float32 object at 0x...>"); their `.name` is the
            # real ClickHouse type ("Float32", "Nullable(Float32)"). Use it so
            # type-based logic (numeric measure detection, JSON inference) works.
            type_name = getattr(type_info, "name", None) or str(type_info)
            is_nullable = "Nullable" in type_name
            columns.append(ColumnInfo(name=name, type_name=type_name, is_nullable=is_nullable))
        self._allowed_columns = {c.name for c in columns}
        return columns

    def get_schema_tables(self) -> list[SchemaTable]:
        # Introspect every non-system database, not just the connection's current
        # one: on real ClickHouse the user's tables often live in a different
        # database than the connection default, or they reference `db.table`
        # across databases. `database = currentDatabase()` is computed server-side
        # so the "bare vs qualified" decision is correct even when the connection
        # has no/`default` database set (the server resolves currentDatabase()).
        excluded = ", ".join(f"'{name}'" for name in _SYSTEM_DATABASES)
        sql = (
            "SELECT database, table, name, type, "
            "database = currentDatabase() AS is_current_database "
            "FROM system.columns "
            f"WHERE database NOT IN ({excluded}) "
            f"ORDER BY database, table, position LIMIT {_SCHEMA_ROW_LIMIT}"
        )
        logger.debug("CH schema introspection query: %s", sql)
        # No per-query settings: tripl connects with read-only ClickHouse users,
        # which reject setting overrides ("Setting ... is unknown or readonly").
        # The row LIMIT and the connection-level timeout bound the query instead.
        result = self._client.query(sql)
        # Tables in the current/default database keep their bare name (`events`);
        # tables in any other database are qualified as `database.table`
        # (`analytics.orders`). The frontend relies on this: a table name has at
        # most one dot, and only when it lives outside the default database.
        columns_by_table: dict[str, list[SchemaColumn]] = {}
        for database, table, name, type_name, is_current_database in result.result_rows:
            qualified_name = str(table) if is_current_database else f"{database}.{table}"
            columns_by_table.setdefault(qualified_name, []).append(
                SchemaColumn(name=str(name), data_type=str(type_name))
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
        logger.info("CH preview query: %s", sql)
        result = self._client.query(sql)
        return list(result.column_names), result.result_rows

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
        """Discover JSON paths independently from visible preview rows.

        The enumeration function is chosen by the connection's json_path_discovery
        mode: "dynamic" (JSONDynamicPaths, default) surfaces only the important
        typed subcolumn paths and is much faster on wide JSON columns; "all"
        (JSONAllPaths) lists every path including shared-data ones. It runs across
        the source query so the UI sees path candidates even when they do not
        appear in the small preview sample. Scan-time value extraction always uses
        JSONAllPaths and is unaffected by this setting.
        """
        if not json_columns or path_limit <= 0 or sample_limit <= 0 or sample_row_limit <= 0:
            return {column: {} for column in json_columns}

        samples_by_column: dict[str, dict[str, list[object]]] = {}
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)
        # Bound discovery to a sample of source rows. The path enumeration below
        # otherwise scans the whole source (no LIMIT survives a GROUP BY), which
        # turns into a full-table scan and trips the timeout on large tables.
        sampled_source = (
            f"(SELECT * FROM ({base_query}) AS _src{where_clause} LIMIT {int(sample_row_limit)})"
        )
        path_fn = _JSON_PATH_DISCOVERY_FUNCS[self._json_path_discovery]
        for column in json_columns:
            c = self._validate_column(column)
            path_sql = (
                "SELECT _path "
                "FROM ("
                f"SELECT arrayJoin({path_fn}(`{c}`)) AS _path "
                f"FROM {sampled_source} AS _sample"
                ") "
                "WHERE _path != '' "
                "GROUP BY _path "
                "ORDER BY _path "
                f"LIMIT {int(path_limit)}"
            )
            logger.info("CH JSON path discovery query: %s", path_sql)
            path_result = self._client.query(path_sql)

            paths: list[str] = []
            for row in path_result.result_rows:
                path = str(row[0])
                try:
                    self._json_path_expression(c, path)
                except ValueError:
                    logger.info("Skipping unsupported JSON path %s.%s", c, path)
                    continue
                paths.append(path)

            column_samples: dict[str, list[object]] = {path: [] for path in paths}
            samples_by_column[c] = column_samples
            if not paths:
                continue

            select_parts: list[str] = []
            path_by_alias: dict[str, str] = {}
            for index, path in enumerate(paths):
                alias = f"__json_path_{index}"
                select_parts.append(
                    f"toJSONString({self._json_path_expression(c, path)}) AS `{alias}`"
                )
                path_by_alias[alias] = path

            sample_sql = f"SELECT {', '.join(select_parts)} FROM {sampled_source} AS _sample"
            logger.info("CH JSON path sample query: %s", sample_sql)
            sample_result = self._client.query(sample_sql)
            index_to_path = {
                index: path_by_alias[name]
                for index, name in enumerate(sample_result.column_names)
                if name in path_by_alias
            }
            seen_by_path: dict[str, set[str]] = {path: set() for path in paths}

            for row in sample_result.result_rows:
                if all(len(values) >= sample_limit for values in column_samples.values()):
                    break
                for index, path in index_to_path.items():
                    if len(column_samples[path]) >= sample_limit:
                        continue
                    value = row[index]
                    if value is None or value == "null":
                        continue
                    sample_key = str(value)
                    if sample_key in seen_by_path[path]:
                        continue
                    seen_by_path[path].add(sample_key)
                    column_samples[path].append(value)

        return samples_by_column

    def _validate_column(self, column: str) -> str:
        if not _IDENTIFIER_RE.match(column):
            msg = f"Invalid column name: {column}"
            raise ValueError(msg)
        if self._allowed_columns and column not in self._allowed_columns:
            msg = f"Column {column!r} not found in query result"
            raise ValueError(msg)
        return column

    def _bucket_expression(self, time_column: str, interval_code: str) -> str:
        """Translate an interval code into ClickHouse bucket SQL.

        Must agree with ``tripl.core.bucketing.floor_to_bucket``.

        The explicit ``'UTC'`` argument is load-bearing: without it
        ``toStartOfInterval`` buckets in the *column's* timezone, so a DateTime
        column declared in, say, ``Asia/Tokyo`` lands rows in the wrong day
        (verified on ClickHouse 26.6 — a Tokyo 05:30 row buckets to the Tokyo day,
        not the UTC one).

        The week form needs a word, because the obvious reading is wrong.
        ClickHouse's ``toStartOfInterval(col, INTERVAL 1 WEEK)`` does *not* bin off
        the epoch Thursday — it is already Monday-aligned and anchored at
        1970-01-05, i.e. it agrees with :data:`~tripl.core.bucketing.WEEK_ORIGIN`.
        ``toMonday`` is used anyway for a different reason: ``toStartOfInterval``
        with a WEEK interval returns a **Date**, not a DateTime, so a 1w bucket
        would come back from clickhouse-connect as ``datetime.date`` while every
        other interval yields ``datetime.datetime``. ``toDateTime(toMonday(...))``
        keeps the bucket column a DateTime across all five intervals.
        """
        spec = get_interval(interval_code)
        col = f"`{self._validate_column(time_column)}`"
        if spec.unit is IntervalUnit.week:
            return f"toDateTime(toMonday({col}, 'UTC'), 'UTC')"
        return f"toStartOfInterval({col}, INTERVAL {spec.count} {spec.unit.value.upper()}, 'UTC')"

    def _json_path_expression(self, column: str, path: str) -> str:
        parts = [part for part in path.split(".") if part]
        if not parts:
            raise ValueError(f"Invalid JSON path: {path}")
        if any(not _IDENTIFIER_PART_RE.match(part) for part in parts):
            raise ValueError(f"Unsupported JSON path: {path}")

        expression = f"`{self._validate_column(column)}`"
        for part in parts:
            expression += f".`{part}`"
        return expression

    def _string_value_expression(self, column: str) -> str:
        return f"ifNull(toString(`{self._validate_column(column)}`), '')"

    def _quote_string(self, value: str) -> str:
        escaped = value.replace("\\", "\\\\").replace("'", "\\'")
        return f"'{escaped}'"

    def _utc_literal(self, value: datetime) -> str:
        """Render a datetime as an unambiguously-UTC ClickHouse timestamp.

        The old form here was ``value.strftime("%Y-%m-%d %H:%M:%S")``, which is
        wrong twice over: ``strftime`` silently drops ``tzinfo`` (an aware
        non-UTC datetime yields its *local* wall clock, not the UTC instant), and
        the resulting offset-less literal is read by ClickHouse in the **column's**
        timezone. Verified on ClickHouse 26.6: against a ``DateTime('Asia/Tokyo')``
        column, ``col >= '2026-07-12 05:30:00'`` compares the literal as Tokyo
        wall-clock and answers *true*, where the same instant expressed in UTC
        answers *false*. That is a whole-window shift on any non-UTC column.

        :func:`~tripl.core.bucketing.format_utc_literal` emits the instant with an
        explicit ``+00:00``. ``parseDateTime64BestEffort`` is the function that
        honors that offset (verified: ``...+03:00`` parses to 02:30Z, not 05:30Z)
        and it returns ``DateTime64(6, 'UTC')`` — scale 6 so the microseconds the
        contract preserves survive into the bound, and a pinned result timezone so
        the comparison cannot be reinterpreted in the column's or server's zone.
        """
        return f"parseDateTime64BestEffort('{format_utc_literal(value)}', 6, 'UTC')"

    def _time_condition(
        self,
        time_column: str | None,
        time_from: datetime | None,
        time_to: datetime | None,
    ) -> str:
        """The half-open ``[from, to)`` window predicate, or ``""`` if unbounded.

        The single definition of the time window for every query this adapter
        builds — preview, JSON path discovery, field contracts, breakdown
        top-values and all five bucketed scans. It used to be copy-pasted six
        times, which is how six of them ended up with the same timezone bug.
        """
        if time_column is None or time_from is None or time_to is None:
            return ""
        tc = self._validate_column(time_column)
        return f"`{tc}` >= {self._utc_literal(time_from)} AND `{tc}` < {self._utc_literal(time_to)}"

    def _time_window_where_clause(
        self,
        time_column: str | None,
        time_from: datetime | None,
        time_to: datetime | None,
    ) -> str:
        condition = self._time_condition(time_column, time_from, time_to)
        return f" WHERE {condition}" if condition else ""

    def _contract_where_clause(
        self,
        time_column: str | None,
        time_from: datetime | None,
        time_to: datetime | None,
        group_column: str | None,
        group_value: str | None,
    ) -> str:
        conditions: list[str] = []
        time_condition = self._time_condition(time_column, time_from, time_to)
        if time_condition:
            conditions.append(time_condition)
        if group_column is not None:
            gc = self._validate_column(group_column)
            expected = self._quote_string(group_value or "")
            conditions.append(f"ifNull(toString(`{gc}`), '') = {expected}")
        if not conditions:
            return ""
        return " WHERE " + " AND ".join(conditions)

    def _contract_select_sql(
        self,
        expectation: FieldContractExpectation,
        *,
        base_query: str,
        where_clause: str,
        index: int,
    ) -> str | None:
        column = self._validate_column(expectation.field_name)
        value_expr = f"ifNull(toString(`{column}`), '')"
        threshold = max(0.0, min(1.0, expectation.threshold))
        drift_type = self._quote_string(expectation.drift_type)
        field_name = self._quote_string(expectation.field_name)

        if expectation.drift_type == "required_null_violation":
            bad_condition = f"isNull(`{column}`)"
            total_expr = "count()"
            sample_expr = f"anyIf('<NULL>', {bad_condition})"
        elif expectation.drift_type == "enum_violation":
            if not expectation.enum_options:
                return None
            options = ", ".join(self._quote_string(option) for option in expectation.enum_options)
            present_condition = f"NOT isNull(`{column}`)"
            bad_condition = f"{present_condition} AND {value_expr} NOT IN ({options})"
            total_expr = f"countIf({present_condition})"
            sample_expr = f"anyIf({value_expr}, {bad_condition})"
        elif expectation.drift_type == "regex_violation":
            if not expectation.regex:
                return None
            present_condition = f"NOT isNull(`{column}`)"
            pattern = self._quote_string(expectation.regex)
            bad_condition = f"{present_condition} AND NOT match({value_expr}, {pattern})"
            total_expr = f"countIf({present_condition})"
            sample_expr = f"anyIf({value_expr}, {bad_condition})"
        elif expectation.drift_type == "range_violation":
            if expectation.min_value is None and expectation.max_value is None:
                return None
            present_condition = f"NOT isNull(`{column}`)"
            numeric_expr = f"toFloat64OrNull({value_expr})"
            range_conditions = [f"isNull({numeric_expr})"]
            if expectation.min_value is not None:
                range_conditions.append(f"{numeric_expr} < {float(expectation.min_value)}")
            if expectation.max_value is not None:
                range_conditions.append(f"{numeric_expr} > {float(expectation.max_value)}")
            bad_condition = f"{present_condition} AND ({' OR '.join(range_conditions)})"
            total_expr = f"countIf({present_condition})"
            sample_expr = f"anyIf({value_expr}, {bad_condition})"
        else:
            return None

        alias = f"_contract_{index}"
        return (
            "SELECT "
            f"{field_name} AS field_name, "
            f"{drift_type} AS drift_type, "
            "bad_count, "
            "total_count, "
            f"{threshold:.12g} AS threshold, "
            "if(total_count = 0, 0., bad_count / total_count) AS bad_rate, "
            "sample_value "
            "FROM ("
            "SELECT "
            f"countIf({bad_condition}) AS bad_count, "
            f"{total_expr} AS total_count, "
            f"{sample_expr} AS sample_value "
            f"FROM ({base_query}) AS _src{where_clause}"
            f") AS {alias} "
            "WHERE total_count > 0 "
            "AND bad_count > 0 "
            f"AND (bad_count / total_count) > {threshold:.12g}"
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

        sql = " UNION ALL ".join(selects) + f" LIMIT {int(limit)}"
        logger.info("CH field contract query: %s", sql)
        result = self._client.query(sql)

        violations: list[FieldContractViolation] = []
        for row in result.result_rows:
            violations.append(
                FieldContractViolation(
                    field_name=str(row[0]),
                    drift_type=str(row[1]),
                    bad_count=int(row[2]),
                    total_count=int(row[3]),
                    threshold=float(row[4]),
                    bad_rate=float(row[5]),
                    sample_value=None if row[6] is None else str(row[6]),
                )
            )
        return violations

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
        breakdown_cols = [self._validate_column(column) for column in breakdown_columns]
        where_clause = self._time_window_where_clause(tc, time_from, time_to)
        prepared_parts = [
            f"{self._string_value_expression(column)} AS `__bd_raw_{idx}`"
            for idx, column in enumerate(breakdown_cols)
        ]
        branch_conditions = [
            f"GROUPING(`__bd_raw_{idx}`) = 0, {self._quote_string(column)}"
            for idx, column in enumerate(breakdown_cols)
        ]
        value_conditions = [
            f"GROUPING(`__bd_raw_{idx}`) = 0, `__bd_raw_{idx}`"
            for idx in range(len(breakdown_cols))
        ]
        grouping_sets = ", ".join(f"(`__bd_raw_{idx}`)" for idx in range(len(breakdown_cols)))
        sql = (
            "SELECT _breakdown_column, _breakdown_value "
            "FROM ("
            "SELECT "
            f"multiIf({', '.join(branch_conditions)}, '') AS _breakdown_column, "
            f"multiIf({', '.join(value_conditions)}, '') AS _breakdown_value, "
            "count() AS _cnt "
            "FROM ("
            f"SELECT {', '.join(prepared_parts)} "
            f"FROM ({base_query}) AS _src{where_clause}"
            ") AS _prepared "
            f"GROUP BY GROUPING SETS ({grouping_sets})"
            ") "
            "ORDER BY _breakdown_column, _cnt DESC "
            f"LIMIT {int(limit)} BY _breakdown_column"
        )
        logger.info("CH breakdown top-values GROUPING SETS query: %s", sql)
        result = self._client.query(sql)
        top_values: dict[str, list[str]] = {column: [] for column in breakdown_cols}
        for column, value in result.result_rows:
            top_values.setdefault(str(column), []).append(str(value))
        return top_values

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
        """Single GROUP BY ALL query: regular cols + JSONAllPaths(json cols) + count().

        Returns (regular_col_names, json_col_names, rows).
        """
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}
        json_value_names: list[str] = []

        select_parts: list[str] = []
        for c in reg_cols:
            select_parts.append(f"`{c}`")
        for c in json_cols:
            select_parts.append(f"arraySort(JSONAllPaths(`{c}`))")
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                select_parts.append(
                    f"toJSONString({self._json_path_expression(c, path)}) AS `{full_path}`"
                )
                json_value_names.append(full_path)
        select_parts.append("count() AS _cnt")
        where_clause = self._time_window_where_clause(time_column, time_from, time_to)

        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY ALL "
            f"ORDER BY _cnt DESC "
            f"LIMIT {int(limit)}"
        )

        short = sql[:300] + ("..." if len(sql) > 300 else "")
        logger.info(f"CH breakdown query: {short}")
        t0 = time.monotonic()
        result = self._client.query(sql)
        elapsed = time.monotonic() - t0
        n_rows = len(result.result_rows)
        logger.info(f"CH breakdown done in {elapsed:.2f}s, {n_rows} rows")

        return reg_cols, json_cols, json_value_names, result.result_rows

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
        """Time-bucketed GROUP BY ALL with all columns, like get_full_breakdown.

        Returns (column_names, rows).
        Row layout: (_bucket, col1_val, ..., json_paths1, ..., count).
        """
        tc = self._validate_column(time_column)
        bucket_sql = self._bucket_expression(tc, interval)
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}

        select_parts = [f"{bucket_sql} AS _bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(f"`{c}`")
            col_names.append(c)
        for c in json_cols:
            select_parts.append(f"arraySort(JSONAllPaths(`{c}`))")
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                select_parts.append(
                    f"toJSONString({self._json_path_expression(c, path)}) AS `{full_path}`"
                )
                json_value_names.append(full_path)
        select_parts.append("count() AS _cnt")

        where_clause = self._time_window_where_clause(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY ALL "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.info(f"CH bucketed query: {sql}")
        t0 = time.monotonic()
        result = self._client.query(sql)
        elapsed = time.monotonic() - t0
        n_rows = len(result.result_rows)
        logger.info(f"CH bucketed done in {elapsed:.2f}s, {n_rows} rows")

        return col_names, json_value_names, result.result_rows

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
        """Time-bucketed aggregate, mirroring get_time_bucketed_counts.

        Returns (column_names, json_value_names, rows).
        Row layout: (_bucket, col1_val, ..., json_paths1, ..., aggregate_value).
        """
        tc = self._validate_column(time_column)
        bucket_sql = self._bucket_expression(tc, interval)
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}
        value_sql = self._aggregate_value_sql(agg_fn, measure_column)

        select_parts = [f"{bucket_sql} AS _bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(f"`{c}`")
            col_names.append(c)
        for c in json_cols:
            select_parts.append(f"arraySort(JSONAllPaths(`{c}`))")
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                select_parts.append(
                    f"toJSONString({self._json_path_expression(c, path)}) AS `{full_path}`"
                )
                json_value_names.append(full_path)
        select_parts.append(f"{value_sql} AS _value")

        where_clause = self._time_window_where_clause(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY ALL "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.info("CH bucketed aggregate query: %s", sql)
        t0 = time.monotonic()
        result = self._client.query(sql)
        elapsed = time.monotonic() - t0
        n_rows = len(result.result_rows)
        logger.info("CH bucketed aggregate done in %.2fs, %s rows", elapsed, n_rows)

        return col_names, json_value_names, result.result_rows

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
        """Time-bucketed aggregate grouped by one breakdown column.

        Returns (column_names, json_value_names, rows).
        Row layout: (_bucket, _breakdown_value, _is_other, col1_val, ..., aggregate_value).
        """
        tc = self._validate_column(time_column)
        bucket_sql = self._bucket_expression(tc, interval)
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

        select_parts = [f"{bucket_sql} AS _bucket"]
        select_parts.append(f"{breakdown_expr} AS _breakdown_value")
        select_parts.append(f"{is_other_expr} AS _is_other")
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            select_parts.append(f"`{c}`")
            col_names.append(c)
        for c in json_cols:
            select_parts.append(f"arraySort(JSONAllPaths(`{c}`))")
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                select_parts.append(
                    f"toJSONString({self._json_path_expression(c, path)}) AS `{full_path}`"
                )
                json_value_names.append(full_path)
        select_parts.append(f"{value_sql} AS _value")

        where_clause = self._time_window_where_clause(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY ALL "
            f"ORDER BY _bucket, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.info("CH bucketed aggregate breakdown query for %s: %s", breakdown, sql)
        t0 = time.monotonic()
        result = self._client.query(sql)
        elapsed = time.monotonic() - t0
        n_rows = len(result.result_rows)
        logger.info("CH bucketed aggregate breakdown done in %.2fs, %s rows", elapsed, n_rows)

        return col_names, json_value_names, result.result_rows

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
        """Build the (breakdown_value, is_other) expressions with Other folding.

        Reuses the count path's top-values selection so the aggregate breakdown
        buckets identically to get_time_bucketed_breakdown_counts.
        """
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
        quoted = ", ".join(self._quote_string(value) for value in top_values)
        in_values = f"{raw_expr} IN ({quoted})"
        return f"if({in_values}, {raw_expr}, 'Other')", f"if({in_values}, 0, 1)"

    def _spec_aggregate_sql(self, spec: AggregateSpec) -> str:
        """Build one (optionally conditional) aggregate fragment for a spec.

        With no ``filter_sql`` this reuses the single-aggregate path
        (``validate_measure_column`` + ``build_aggregate_sql``) so the unfiltered
        value is IDENTICAL to ``get_time_bucketed_aggregate`` (``count(*)`` /
        ``sum(m)`` / ``avg(m)`` / ``min(m)`` / ``max(m)`` / ``count(DISTINCT m)``).
        When ``filter_sql`` is set, the aggregate becomes a ClickHouse conditional
        ``-If`` variant (``countIf`` / ``sumIf`` / ``avgIf`` / ``minIf`` /
        ``maxIf`` / ``uniqExactIf``) so specs with different filters share one
        scan. ``filter_sql`` is a pre-validated boolean fragment injected as-is,
        the same trust model as the single-metric row-filter path.

        Each conditional aggregate is wrapped in ``if(countIf(cond) = 0, NULL,
        ...)`` so a bucket with rows but none matching ``cond`` reads as NULL
        (absent) for that key. This is required for value-identity with the
        per-metric path, whose filtered scan emits no row at all for such a
        bucket: ClickHouse ``-If`` functions instead return the numeric default
        (``countIf``/``sumIf`` -> 0) or a type extreme/NaN (``minIf``/``maxIf``/
        ``avgIf``) for empty groups, none of which is NULL. The count sentinel
        also preserves a genuine aggregate of 0 (e.g. ``sumIf`` over rows that
        net to zero) because the bucket still has matching rows.
        """
        agg = coerce_aggregation(spec.aggregation)
        measure_sql: str | None = None
        if spec.column is not None:
            measure_sql = f"`{validate_measure_column(spec.column, self._allowed_columns)}`"

        if not spec.filter_sql:
            return build_aggregate_sql(agg, measure_sql)

        cond = spec.filter_sql
        if agg is MetricAggregation.count:
            inner = f"countIf({cond})"
        elif agg is MetricAggregation.count_distinct:
            if not measure_sql:
                msg = f"Aggregation {agg.value!r} requires a measure column"
                raise ValueError(msg)
            inner = f"uniqExactIf({measure_sql}, {cond})"
        else:
            if not measure_sql:
                msg = f"Aggregation {agg.value!r} requires a measure column"
                raise ValueError(msg)
            # sum/avg/min/max map their enum value onto the conditional -If variant.
            inner = f"{agg.value}If({measure_sql}, {cond})"
        return f"if(countIf({cond}) = 0, NULL, {inner})"

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
        """Many bucketed aggregates from ONE source scan.

        Mirrors get_time_bucketed_aggregate's windowing, bucketing, quoting and
        row limit, but emits one (optionally conditional) aggregate column per
        spec aliased by ``spec.key``.
        """
        tc = self._validate_column(time_column)
        bucket_sql = self._bucket_expression(tc, interval)

        select_parts = [f"{bucket_sql} AS _bucket"]
        col_names: list[str] = ["bucket"]
        for spec in specs:
            select_parts.append(f"{self._spec_aggregate_sql(spec)} AS `{spec.key}`")
            col_names.append(spec.key)

        where_clause = self._time_window_where_clause(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY _bucket "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.info("CH bucketed multi-aggregate query: %s", sql)
        t0 = time.monotonic()
        result = self._client.query(sql)
        elapsed = time.monotonic() - t0
        n_rows = len(result.result_rows)
        logger.info("CH bucketed multi-aggregate done in %.2fs, %s rows", elapsed, n_rows)

        return col_names, result.result_rows

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
        """Many bucketed aggregates grouped by one breakdown column, ONE scan.

        Reuses ``_breakdown_value_exprs`` so the top-N "Other" folding matches
        get_time_bucketed_aggregate_breakdown exactly, then emits one aggregate
        column per spec.
        """
        tc = self._validate_column(time_column)
        bucket_sql = self._bucket_expression(tc, interval)
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

        select_parts = [
            f"{bucket_sql} AS _bucket",
            f"{breakdown_expr} AS _breakdown_value",
            f"{is_other_expr} AS _is_other",
        ]
        col_names: list[str] = ["bucket", "breakdown_value", "is_other"]
        for spec in specs:
            select_parts.append(f"{self._spec_aggregate_sql(spec)} AS `{spec.key}`")
            col_names.append(spec.key)

        where_clause = self._time_window_where_clause(tc, time_from, time_to)
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src{where_clause} "
            f"GROUP BY ALL "
            f"ORDER BY _bucket, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.info("CH bucketed multi-aggregate breakdown query for %s: %s", breakdown, sql)
        t0 = time.monotonic()
        result = self._client.query(sql)
        elapsed = time.monotonic() - t0
        n_rows = len(result.result_rows)
        logger.info("CH bucketed multi-aggregate breakdown done in %.2fs, %s rows", elapsed, n_rows)

        return col_names, result.result_rows

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
        """Time-bucketed GROUPING SETS query for independent breakdown columns.

        All event matching columns stay in every grouping set so rows can still
        be mapped to catalog events after ClickHouse has done the counting.
        """
        if not breakdown_columns:
            return [], [], []

        tc = self._validate_column(time_column)
        bucket_sql = self._bucket_expression(tc, interval)
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        breakdown_cols = [self._validate_column(c) for c in breakdown_columns]
        invalid_breakdown_cols = [column for column in breakdown_cols if column not in reg_cols]
        if invalid_breakdown_cols:
            msg = f"Breakdown columns must be scalar columns: {', '.join(invalid_breakdown_cols)}"
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

        prepared_parts = [f"{bucket_sql} AS _bucket"]
        col_names: list[str] = []
        json_value_names: list[str] = []
        for c in reg_cols:
            prepared_parts.append(f"`{c}` AS `{c}`")
            col_names.append(c)
        for c in json_cols:
            prepared_parts.append(f"arraySort(JSONAllPaths(`{c}`)) AS `{c}`")
            col_names.append(c)
        for c in json_cols:
            for path in json_value_paths.get(c, []):
                full_path = f"{c}.{path}"
                prepared_parts.append(
                    f"toJSONString({self._json_path_expression(c, path)}) AS `{full_path}`"
                )
                json_value_names.append(full_path)

        grouping_columns = [f"`{name}`" for name in [*reg_cols, *json_cols, *json_value_names]]
        breakdown_label_conditions: list[str] = []
        breakdown_value_conditions: list[str] = []
        breakdown_other_conditions: list[str] = []
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
                quoted_values = ", ".join(self._quote_string(value) for value in top_values)
                in_values = f"{raw_expr} IN ({quoted_values})"
                breakdown_expr = f"if({in_values}, {raw_expr}, 'Other')"
                is_other_expr = f"if({in_values}, 0, 1)"
            else:
                breakdown_expr = "'Other'"
                is_other_expr = "1"

            prepared_parts.append(f"{breakdown_expr} AS `{value_alias}`")
            prepared_parts.append(f"{is_other_expr} AS `{other_alias}`")
            grouping_check = f"GROUPING(`{value_alias}`) = 0"
            breakdown_label_conditions.append(f"{grouping_check}, {self._quote_string(column)}")
            breakdown_value_conditions.append(f"{grouping_check}, `{value_alias}`")
            breakdown_other_conditions.append(f"{grouping_check}, `{other_alias}`")
            grouping_sets.append(
                "("
                + ", ".join(
                    [
                        "`_bucket`",
                        f"`{value_alias}`",
                        f"`{other_alias}`",
                        *grouping_columns,
                    ]
                )
                + ")"
            )

        select_parts = [
            "`_bucket`",
            f"multiIf({', '.join(breakdown_label_conditions)}, '') AS _breakdown_column",
            f"multiIf({', '.join(breakdown_value_conditions)}, '') AS _breakdown_value",
            f"multiIf({', '.join(breakdown_other_conditions)}, 0) AS _is_other",
            *grouping_columns,
            "count() AS _cnt",
        ]

        where_clause = self._time_window_where_clause(tc, time_from, time_to)
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
            "CH bucketed breakdown GROUPING SETS query for %s: %s",
            ", ".join(breakdown_cols),
            sql,
        )
        t0 = time.monotonic()
        result = self._client.query(sql)
        elapsed = time.monotonic() - t0
        n_rows = len(result.result_rows)
        logger.info("CH bucketed breakdown GROUPING SETS done in %.2fs, %s rows", elapsed, n_rows)

        return col_names, json_value_names, result.result_rows
