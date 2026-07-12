from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime

import pytest

from tripl.core.adapters.base import AggregateSpec
from tripl.core.adapters.bigquery import BigQueryAdapter
from tripl.core.adapters.clickhouse import ClickHouseAdapter
from tripl.core.adapters.postgres import PostgresAdapter
from tripl.models.domain_enums import MetricAggregation

_FROM = datetime(2026, 4, 1, 0, 0)
_TO = datetime(2026, 4, 2, 0, 0)
_ALLOWED = {"time", "event_name", "amount", "user_id"}
_BASE = "SELECT time, event_name, amount, user_id FROM events"

# Window bounds now carry an explicit +00:00 offset in every dialect (see
# `tripl.core.bucketing.format_utc_literal`): an offset-less literal is read in the
# session/column timezone, which shifts the whole window on a non-UTC warehouse.
_CH_WINDOW = (
    "WHERE `time` >= parseDateTime64BestEffort('2026-04-01 00:00:00.000000+00:00', 6, 'UTC') "
    "AND `time` < parseDateTime64BestEffort('2026-04-02 00:00:00.000000+00:00', 6, 'UTC')"
)
_PG_WINDOW = (
    "WHERE \"time\" >= TIMESTAMPTZ '2026-04-01 00:00:00.000000+00:00' "
    "AND \"time\" < TIMESTAMPTZ '2026-04-02 00:00:00.000000+00:00'"
)
_BQ_WINDOW_LOWER = "WHERE `time` >= TIMESTAMP '2026-04-01 00:00:00.000000+00:00'"

# Bucket grids are anchored explicitly: sub-week at the Unix epoch, 1w on Monday.
_CH_BUCKET_1H = "toStartOfInterval(`time`, INTERVAL 1 HOUR, 'UTC') AS _bucket"
_CH_BUCKET_1D = "toStartOfInterval(`time`, INTERVAL 1 DAY, 'UTC') AS _bucket"
_PG_BUCKET_1H = (
    "date_bin(INTERVAL '1 hours', \"time\", "
    "TIMESTAMPTZ '1970-01-01 00:00:00.000000+00:00') AS _bucket"
)
_BQ_BUCKET_1H = (
    "TIMESTAMP_BUCKET(`time`, INTERVAL 1 HOUR, "
    "TIMESTAMP '1970-01-01 00:00:00.000000+00:00') AS _bucket"
)


# --- ClickHouse fakes -------------------------------------------------------


class _CHResult:
    column_names: list[str] = []
    result_rows: list[tuple[object, ...]] = []


class _CHClient:
    def __init__(self) -> None:
        self.sql: list[str] = []

    def query(self, sql: str, **_kwargs: object) -> _CHResult:
        self.sql.append(sql)
        return _CHResult()


def _ch() -> tuple[ClickHouseAdapter, _CHClient]:
    client = _CHClient()
    adapter = object.__new__(ClickHouseAdapter)
    adapter._client = client
    adapter._allowed_columns = set(_ALLOWED)
    adapter._json_path_discovery = "dynamic"
    return adapter, client


# --- Postgres fakes ---------------------------------------------------------


class _PGCursor:
    def __init__(self, client: _PGConn) -> None:
        self._client = client
        self.description: list[object] = []

    def __enter__(self) -> _PGCursor:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def execute(self, sql: str) -> None:
        self._client.sql.append(sql)

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._client.rows


class _PGConn:
    def __init__(self) -> None:
        self.sql: list[str] = []
        # Seedable rows returned by every cursor.fetchall(); used to drive the
        # top-values response that feeds Other-folding.
        self.rows: list[tuple[object, ...]] = []

    def cursor(self) -> _PGCursor:
        return _PGCursor(self)


def _pg() -> tuple[PostgresAdapter, _PGConn]:
    conn = _PGConn()
    adapter = object.__new__(PostgresAdapter)
    adapter._conn = conn
    adapter._allowed_columns = set(_ALLOWED)
    return adapter, conn


# --- BigQuery fakes ---------------------------------------------------------


class _BQRow:
    def __init__(self, values: tuple[object, ...]) -> None:
        self._values = values

    def values(self) -> tuple[object, ...]:
        return self._values


class _BQResult:
    schema: list[object] = []

    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows

    def __iter__(self) -> Iterator[object]:
        return iter(_BQRow(r) for r in self._rows)


class _BQJob:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows

    def result(self, **_kwargs: object) -> _BQResult:
        return _BQResult(self._rows)


class _BQClient:
    def __init__(self) -> None:
        self.sql: list[str] = []
        # Seedable rows returned by every query(); used to drive the top-values
        # response that feeds Other-folding.
        self.rows: list[tuple[object, ...]] = []

    def query(self, sql: str) -> _BQJob:
        self.sql.append(sql)
        return _BQJob(self.rows)


def _bq(time_type: str = "TIMESTAMP") -> tuple[BigQueryAdapter, _BQClient]:
    client = _BQClient()
    adapter = object.__new__(BigQueryAdapter)
    adapter._client = client
    adapter._allowed_columns = set(_ALLOWED)
    # The bucket function and the window literal are now chosen from the column's
    # *declared* type, so the fake declares one. Pre-seeding also keeps
    # `_ensure_column_types` from firing its own `LIMIT 0` schema probe, which would
    # otherwise land at `client.sql[0]` ahead of the query under test.
    adapter._column_types = {"time": time_type, "event_name": "STRING", "amount": "FLOAT64"}
    adapter._struct_paths = {}
    # BigQuery reports an ARRAY<STRING> column as field_type STRING + mode=REPEATED, so
    # array-ness lives only in the mode and the adapter has to remember it: a repeated
    # column can be neither GROUPed BY nor CAST to STRING. None here.
    adapter._repeated_columns = set()
    return adapter, client


# --- ClickHouse aggregate ---------------------------------------------------


@pytest.mark.parametrize(
    ("agg", "measure", "expected"),
    [
        (MetricAggregation.count, None, "count(*) AS _value"),
        (MetricAggregation.sum, "amount", "sum(`amount`) AS _value"),
        (MetricAggregation.avg, "amount", "avg(`amount`) AS _value"),
        (MetricAggregation.min, "amount", "min(`amount`) AS _value"),
        (MetricAggregation.max, "amount", "max(`amount`) AS _value"),
        (MetricAggregation.count_distinct, "user_id", "count(DISTINCT `user_id`) AS _value"),
    ],
)
def test_clickhouse_aggregate_sql(
    agg: MetricAggregation, measure: str | None, expected: str
) -> None:
    adapter, client = _ch()
    adapter.get_time_bucketed_aggregate(
        _BASE,
        "time",
        "1h",
        agg,
        measure,
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
    )
    sql = client.sql[0]
    assert expected in sql
    assert _CH_BUCKET_1H in sql
    assert "`event_name`" in sql
    assert "GROUP BY ALL" in sql
    assert _CH_WINDOW in sql


def test_clickhouse_aggregate_breakdown_sql() -> None:
    adapter, client = _ch()
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        MetricAggregation.sum,
        "amount",
        breakdown_column="event_name",
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
    )
    sql = client.sql[0]
    assert "sum(`amount`) AS _value" in sql
    assert _CH_BUCKET_1D in sql
    assert "ifNull(toString(`event_name`), '') AS _breakdown_value" in sql
    assert "0 AS _is_other" in sql
    assert "ORDER BY _bucket, _breakdown_value" in sql


def test_clickhouse_aggregate_breakdown_folds_other_with_limit() -> None:
    adapter, client = _ch()
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        MetricAggregation.sum,
        "amount",
        breakdown_column="event_name",
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
        values_limit=1,
    )
    # values_limit=1 -> top_count=0 -> no top values -> everything is 'Other'.
    sql = client.sql[-1]
    assert "'Other' AS _breakdown_value" in sql
    assert "1 AS _is_other" in sql


def test_clickhouse_aggregate_rejects_unknown_measure() -> None:
    adapter, _ = _ch()
    with pytest.raises(ValueError, match="not found in query result"):
        adapter.get_time_bucketed_aggregate(
            _BASE,
            "time",
            "1h",
            MetricAggregation.sum,
            "revenue",
            regular_columns=["event_name"],
            json_columns=[],
            json_value_paths=None,
            time_from=_FROM,
            time_to=_TO,
        )


# --- Postgres aggregate -----------------------------------------------------


@pytest.mark.parametrize(
    ("agg", "measure", "expected"),
    [
        (MetricAggregation.count, None, "count(*) AS _value"),
        (MetricAggregation.sum, "amount", 'sum("amount") AS _value'),
        (MetricAggregation.avg, "amount", 'avg("amount") AS _value'),
        (MetricAggregation.min, "amount", 'min("amount") AS _value'),
        (MetricAggregation.max, "amount", 'max("amount") AS _value'),
        (MetricAggregation.count_distinct, "user_id", 'count(DISTINCT "user_id") AS _value'),
    ],
)
def test_postgres_aggregate_sql(agg: MetricAggregation, measure: str | None, expected: str) -> None:
    adapter, conn = _pg()
    adapter.get_time_bucketed_aggregate(
        _BASE,
        "time",
        "1h",
        agg,
        measure,
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
    )
    sql = conn.sql[0]
    assert expected in sql
    assert _PG_BUCKET_1H in sql
    assert '"event_name"' in sql
    assert "GROUP BY _bucket" in sql
    assert _PG_WINDOW in sql


def test_postgres_aggregate_breakdown_sql() -> None:
    adapter, conn = _pg()
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        MetricAggregation.count_distinct,
        "user_id",
        breakdown_column="event_name",
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
    )
    sql = conn.sql[0]
    assert 'count(DISTINCT "user_id") AS _value' in sql
    assert "COALESCE(\"event_name\"::text, '') AS _breakdown_value" in sql
    assert "0 AS _is_other" in sql
    assert "GROUP BY _bucket, _breakdown_value, _is_other" in sql
    assert "ORDER BY _bucket, _breakdown_value" in sql


# --- Postgres multi-aggregate -----------------------------------------------


def test_postgres_multi_aggregate_select_shape() -> None:
    adapter, conn = _pg()
    conn.rows = [(datetime(2026, 4, 1, 0, 0), 5, 100.0, 3)]
    col_names, rows = adapter.get_time_bucketed_multi_aggregate(
        _BASE,
        "time",
        "1h",
        [
            AggregateSpec(key="c", aggregation=MetricAggregation.count),
            AggregateSpec(key="s", aggregation=MetricAggregation.sum, column="amount"),
            AggregateSpec(key="d", aggregation=MetricAggregation.count_distinct, column="user_id"),
        ],
        time_from=_FROM,
        time_to=_TO,
    )
    assert col_names == ["bucket", "c", "s", "d"]
    assert rows == [(datetime(2026, 4, 1, 0, 0), 5, 100.0, 3)]
    sql = conn.sql[0]
    # One scan, three aggregate columns aliased by their keys.
    assert 'count(*) AS "c"' in sql
    assert 'sum("amount") AS "s"' in sql
    assert 'count(DISTINCT "user_id") AS "d"' in sql
    assert _PG_BUCKET_1H in sql
    assert "GROUP BY _bucket" in sql
    assert "ORDER BY _bucket" in sql
    assert _PG_WINDOW in sql


def test_postgres_multi_aggregate_conditional_filter() -> None:
    adapter, conn = _pg()
    col_names, _ = adapter.get_time_bucketed_multi_aggregate(
        _BASE,
        "time",
        "1d",
        [
            AggregateSpec(
                key="paid",
                aggregation=MetricAggregation.sum,
                column="amount",
                filter_sql="event_name = 'purchase'",
            ),
            AggregateSpec(key="total", aggregation=MetricAggregation.sum, column="amount"),
        ],
        time_from=_FROM,
        time_to=_TO,
    )
    assert col_names == ["bucket", "paid", "total"]
    sql = conn.sql[0]
    # Filtered spec becomes a FILTER (WHERE ...) conditional; unfiltered stays plain.
    assert 'sum("amount") FILTER (WHERE event_name = \'purchase\') AS "paid"' in sql
    assert 'sum("amount") AS "total"' in sql


def test_postgres_multi_aggregate_count_filter() -> None:
    adapter, conn = _pg()
    adapter.get_time_bucketed_multi_aggregate(
        _BASE,
        "time",
        "1h",
        [
            AggregateSpec(
                key="hits",
                aggregation=MetricAggregation.count,
                filter_sql="amount > 0",
            ),
        ],
        time_from=_FROM,
        time_to=_TO,
    )
    sql = conn.sql[0]
    # count FILTER returns 0 (not NULL) for an empty group, so it is NULLIF-wrapped
    # to read as absent — matching the per-metric path's filtered scan.
    assert 'NULLIF(count(*) FILTER (WHERE amount > 0), 0) AS "hits"' in sql


def test_postgres_multi_aggregate_breakdown_select_shape() -> None:
    adapter, conn = _pg()
    conn.rows = [(datetime(2026, 4, 1, 0, 0), "click", 0, 7, 42.0)]
    col_names, rows = adapter.get_time_bucketed_multi_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        "event_name",
        [
            AggregateSpec(key="c", aggregation=MetricAggregation.count),
            AggregateSpec(key="s", aggregation=MetricAggregation.sum, column="amount"),
        ],
        time_from=_FROM,
        time_to=_TO,
    )
    assert col_names == ["bucket", "breakdown_value", "is_other", "c", "s"]
    assert rows == [(datetime(2026, 4, 1, 0, 0), "click", 0, 7, 42.0)]
    sql = conn.sql[0]
    assert 'count(*) AS "c"' in sql
    assert 'sum("amount") AS "s"' in sql
    assert "COALESCE(\"event_name\"::text, '') AS _breakdown_value" in sql
    assert "0 AS _is_other" in sql
    assert "GROUP BY _bucket, _breakdown_value, _is_other" in sql
    assert "ORDER BY _bucket, _breakdown_value" in sql


def test_postgres_multi_aggregate_breakdown_folds_other_with_limit() -> None:
    adapter, conn = _pg()
    # Seed the top-values scan so Other-folding takes the IN (...) branch.
    conn.rows = [("event_name", "click"), ("event_name", "view")]
    adapter.get_time_bucketed_multi_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        "event_name",
        [AggregateSpec(key="s", aggregation=MetricAggregation.sum, column="amount")],
        time_from=_FROM,
        time_to=_TO,
        values_limit=3,
    )
    sql = conn.sql[-1]
    assert "CASE WHEN" in sql
    assert "IN (" in sql
    assert "ELSE 'Other'" in sql


def test_postgres_multi_aggregate_rejects_unknown_measure() -> None:
    adapter, _ = _pg()
    with pytest.raises(ValueError, match="not found in query result"):
        adapter.get_time_bucketed_multi_aggregate(
            _BASE,
            "time",
            "1h",
            [AggregateSpec(key="s", aggregation=MetricAggregation.sum, column="revenue")],
            time_from=_FROM,
            time_to=_TO,
        )


# --- BigQuery aggregate -----------------------------------------------------


@pytest.mark.parametrize(
    ("agg", "measure", "expected"),
    [
        (MetricAggregation.count, None, "count(*) AS _value"),
        (MetricAggregation.sum, "amount", "sum(`amount`) AS _value"),
        (MetricAggregation.avg, "amount", "avg(`amount`) AS _value"),
        (MetricAggregation.min, "amount", "min(`amount`) AS _value"),
        (MetricAggregation.max, "amount", "max(`amount`) AS _value"),
        (MetricAggregation.count_distinct, "user_id", "count(DISTINCT `user_id`) AS _value"),
    ],
)
def test_bigquery_aggregate_sql(agg: MetricAggregation, measure: str | None, expected: str) -> None:
    adapter, client = _bq()
    adapter.get_time_bucketed_aggregate(
        _BASE,
        "time",
        "1h",
        agg,
        measure,
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
    )
    sql = client.sql[0]
    assert expected in sql
    # `TIMESTAMP_BUCKET`, not the old `TIMESTAMP_BIN`: BIN is not a GoogleSQL function
    # at all, so every bucketed BigQuery query this adapter built used to be a syntax
    # error. The origin is the Unix epoch, stated rather than defaulted.
    assert _BQ_BUCKET_1H in sql
    assert "TIMESTAMP_BIN" not in sql
    assert "`event_name`" in sql
    assert "GROUP BY _bucket" in sql
    assert _BQ_WINDOW_LOWER in sql


def test_bigquery_aggregate_breakdown_sql() -> None:
    adapter, client = _bq()
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        MetricAggregation.max,
        "amount",
        breakdown_column="event_name",
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
    )
    sql = client.sql[0]
    assert "max(`amount`) AS _value" in sql
    assert "IFNULL(CAST(`event_name` AS STRING), '') AS _breakdown_value" in sql
    assert "0 AS _is_other" in sql
    assert "GROUP BY _bucket, _breakdown_value, _is_other" in sql
    assert "ORDER BY _bucket, _breakdown_value" in sql


# --- ClickHouse interval validation -----------------------------------------


# Intervals are dialect-neutral codes now, so the allowlist *is* the interval table:
# anything that is not one of the five codes is rejected before it can reach the SQL
# string. That covers the injection attempt and the plausible-but-unknown unit, and
# it now also covers raw ClickHouse `INTERVAL` syntax — no caller may hand a dialect
# fragment to an adapter any more.
@pytest.mark.parametrize("bad", ["1; DROP TABLE x", "1 fortnight", "1 hour", "1 DAY", "1 month"])
def test_clickhouse_aggregate_rejects_bad_interval(bad: str) -> None:
    adapter, _ = _ch()
    with pytest.raises(ValueError, match="Unknown interval code"):
        adapter.get_time_bucketed_aggregate(
            _BASE,
            "time",
            bad,
            MetricAggregation.sum,
            "amount",
            regular_columns=["event_name"],
            json_columns=[],
            json_value_paths=None,
            time_from=_FROM,
            time_to=_TO,
        )


@pytest.mark.parametrize("bad", ["1; DROP TABLE x", "1 fortnight", "1 day"])
def test_clickhouse_aggregate_breakdown_rejects_bad_interval(bad: str) -> None:
    adapter, _ = _ch()
    with pytest.raises(ValueError, match="Unknown interval code"):
        adapter.get_time_bucketed_aggregate_breakdown(
            _BASE,
            "time",
            bad,
            MetricAggregation.sum,
            "amount",
            breakdown_column="event_name",
            regular_columns=["event_name"],
            json_columns=[],
            json_value_paths=None,
            time_from=_FROM,
            time_to=_TO,
        )


# --- PG / BQ Other-folding (IN (...) branch) --------------------------------


def test_postgres_aggregate_breakdown_folds_other_with_limit() -> None:
    adapter, conn = _pg()
    # Seed the top-values scan so Other-folding takes the IN (...) branch.
    conn.rows = [("event_name", "click"), ("event_name", "view")]
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        MetricAggregation.sum,
        "amount",
        breakdown_column="event_name",
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
        values_limit=3,
    )
    sql = conn.sql[-1]
    assert "CASE WHEN" in sql
    assert "IN (" in sql
    assert "ELSE 'Other'" in sql


def test_bigquery_aggregate_breakdown_folds_other_with_limit() -> None:
    adapter, client = _bq()
    # Seed the top-values scan so Other-folding takes the IN (...) branch.
    client.rows = [("event_name", "click"), ("event_name", "view")]
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        MetricAggregation.max,
        "amount",
        breakdown_column="event_name",
        regular_columns=["event_name"],
        json_columns=[],
        json_value_paths=None,
        time_from=_FROM,
        time_to=_TO,
        values_limit=3,
    )
    sql = client.sql[-1]
    assert "CASE WHEN" in sql
    assert "IN (" in sql
    assert "ELSE 'Other'" in sql
