from __future__ import annotations

import logging
import re
import time
from datetime import datetime

import psycopg

from tripl.worker.adapters.base import BaseAdapter, ColumnInfo

logger = logging.getLogger(__name__)

_IDENTIFIER_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")
_IDENTIFIER_PART_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
_INTERVAL_RE = re.compile(r"^\d+\s+(second|minute|hour|day|week|month)s?$", re.IGNORECASE)


def _quote_ident(name: str) -> str:
    # Identifiers are pre-validated by _validate_column; this just adds the quoting.
    return '"' + name.replace('"', '""') + '"'


class PostgresAdapter(BaseAdapter):
    """Postgres-backed warehouse adapter mirroring the ClickHouse semantics.

    Maps ClickHouse-specific features to standard SQL:
      - toStartOfInterval → date_bin
      - JSONAllPaths      → jsonb_object_keys (top-level keys only — nested
                            paths are surfaced as you drill in via json_value_paths)
      - GROUPING SETS     → same syntax (Postgres supports it natively)
      - multiIf           → CASE WHEN / THEN
      - LIMIT n BY col    → ROW_NUMBER() OVER (PARTITION BY ...) wrapper
    """

    def __init__(
        self,
        host: str,
        port: int,
        database: str,
        username: str = "",
        password: str = "",
        **kwargs: object,
    ) -> None:
        self._conn = psycopg.connect(
            host=host,
            port=port,
            dbname=database,
            user=username or "postgres",
            password=password or "",
            autocommit=True,
        )
        self._allowed_columns: set[str] = set()
        self._type_names: dict[int, str] = {}

    def close(self) -> None:
        self._conn.close()

    def test_connection(self) -> bool:
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

    def get_preview_rows(
        self,
        base_query: str,
        limit: int = 10,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        sql = f"SELECT * FROM ({base_query}) AS _src LIMIT {int(limit)}"
        logger.info("PG preview query: %s", sql)
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

    def _validate_interval(self, ch_interval: str) -> str:
        if not _INTERVAL_RE.match(ch_interval.strip()):
            msg = f"Unsupported interval: {ch_interval!r}"
            raise ValueError(msg)
        return ch_interval.strip()

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

    def _json_paths_expression(self, column: str) -> str:
        # Top-level JSONB keys, sorted, returned as a text[] for parity with
        # ClickHouse's `arraySort(JSONAllPaths(col))` output shape.
        c = _quote_ident(self._validate_column(column))
        return (
            f"(SELECT COALESCE(array_agg(k ORDER BY k), ARRAY[]::text[]) "
            f"FROM (SELECT DISTINCT jsonb_object_keys({c}::jsonb) AS k) AS _keys)"
        )

    def get_full_breakdown(
        self,
        base_query: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None = None,
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
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"GROUP BY {group_by} "
            f"ORDER BY _cnt DESC "
            f"LIMIT {int(limit)}"
        )

        short = sql[:300] + ("..." if len(sql) > 300 else "")
        logger.info("PG breakdown query: %s", short)
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
        ch_interval: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        tc = self._validate_column(time_column)
        interval = self._validate_interval(ch_interval)
        reg_cols = [self._validate_column(c) for c in regular_columns]
        json_cols = [self._validate_column(c) for c in json_columns]
        json_value_paths = json_value_paths or {}

        bucket_expr = (
            f"date_bin(INTERVAL '{interval}', {_quote_ident(tc)}, TIMESTAMP 'epoch')"
        )
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

        t_from = time_from.strftime("%Y-%m-%d %H:%M:%S")
        t_to = time_to.strftime("%Y-%m-%d %H:%M:%S")
        sql = (
            f"SELECT {', '.join(select_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {_quote_ident(tc)} >= '{t_from}' AND {_quote_ident(tc)} < '{t_to}' "
            f"GROUP BY {', '.join(group_parts)} "
            f"ORDER BY _bucket "
            f"LIMIT {int(limit)}"
        )

        logger.info("PG bucketed query: %s", sql)
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info("PG bucketed done in %.2fs, %s rows", elapsed, len(rows))

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
            f"{self._string_value_expression(c)} AS \"__bd_raw_{i}\""
            for i, c in enumerate(cols)
        ]
        # One GROUPING SETS scan: per column, GROUP BY that single label so
        # ROW_NUMBER ranks values within that column only.
        grouping_sets = ", ".join(f'("__bd_raw_{i}")' for i in range(len(cols)))
        label_branches = " ".join(
            f"WHEN GROUPING(\"__bd_raw_{i}\") = 0 THEN {self._quote_string(c)}"
            for i, c in enumerate(cols)
        )
        value_branches = " ".join(
            f"WHEN GROUPING(\"__bd_raw_{i}\") = 0 THEN \"__bd_raw_{i}\""
            for i in range(len(cols))
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
            f"WHERE {_quote_ident(tc)} >= '{t_from}' AND {_quote_ident(tc)} < '{t_to}'"
            ") AS _prepared "
            f"GROUP BY GROUPING SETS ({grouping_sets})"
            ") AS _scored"
            ") AS _ranked "
            f"WHERE rn <= {int(limit)}"
        )
        logger.info("PG breakdown top-values query: %s", sql)
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
        interval = self._validate_interval(ch_interval)
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
                base_query, time_column, breakdown_cols, time_from, time_to, top_count,
            )

        bucket_expr = (
            f"date_bin(INTERVAL '{interval}', {_quote_ident(tc)}, TIMESTAMP 'epoch')"
        )
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

        t_from = time_from.strftime("%Y-%m-%d %H:%M:%S")
        t_to = time_to.strftime("%Y-%m-%d %H:%M:%S")
        sql = (
            f"SELECT {', '.join(select_parts)} "
            "FROM ("
            f"SELECT {', '.join(prepared_parts)} "
            f"FROM ({base_query}) AS _src "
            f"WHERE {_quote_ident(tc)} >= '{t_from}' AND {_quote_ident(tc)} < '{t_to}'"
            ") AS _prepared "
            f"GROUP BY GROUPING SETS ({', '.join(grouping_sets)}) "
            "ORDER BY _bucket, _breakdown_column, _breakdown_value "
            f"LIMIT {int(limit)}"
        )

        logger.info(
            "PG bucketed breakdown GROUPING SETS query for %s: %s",
            ", ".join(breakdown_cols),
            sql,
        )
        t0 = time.monotonic()
        with self._conn.cursor() as cur:
            cur.execute(sql)
            rows = [tuple(r) for r in cur.fetchall()]
        elapsed = time.monotonic() - t0
        logger.info("PG bucketed breakdown done in %.2fs, %s rows", elapsed, len(rows))

        return col_names, json_value_names, rows
