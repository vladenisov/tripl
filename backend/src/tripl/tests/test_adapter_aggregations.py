from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime

import pytest

from tripl.core.adapters.bigquery import BigQueryAdapter
from tripl.core.adapters.clickhouse import ClickHouseAdapter
from tripl.core.adapters.postgres import PostgresAdapter
from tripl.models.domain_enums import MetricAggregation

_FROM = datetime(2026, 4, 1, 0, 0)
_TO = datetime(2026, 4, 2, 0, 0)
_ALLOWED = {"time", "event_name", "amount", "user_id"}
_BASE = "SELECT time, event_name, amount, user_id FROM events"


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


def _bq() -> tuple[BigQueryAdapter, _BQClient]:
    client = _BQClient()
    adapter = object.__new__(BigQueryAdapter)
    adapter._client = client
    adapter._allowed_columns = set(_ALLOWED)
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
        "1 hour",
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
    assert "toStartOfInterval(`time`, INTERVAL 1 hour) AS _bucket" in sql
    assert "`event_name`" in sql
    assert "GROUP BY ALL" in sql
    assert "WHERE `time` >= '2026-04-01 00:00:00' AND `time` < '2026-04-02 00:00:00'" in sql


def test_clickhouse_aggregate_breakdown_sql() -> None:
    adapter, client = _ch()
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1 day",
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
    assert "toStartOfInterval(`time`, INTERVAL 1 day) AS _bucket" in sql
    assert "ifNull(toString(`event_name`), '') AS _breakdown_value" in sql
    assert "0 AS _is_other" in sql
    assert "ORDER BY _bucket, _breakdown_value" in sql


def test_clickhouse_aggregate_breakdown_folds_other_with_limit() -> None:
    adapter, client = _ch()
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1 day",
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
            "1 hour",
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
        "1 hour",
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
    assert "date_bin(INTERVAL '1 hour', \"time\", TIMESTAMP 'epoch') AS _bucket" in sql
    assert '"event_name"' in sql
    assert "GROUP BY _bucket" in sql
    assert "WHERE \"time\" >= '2026-04-01 00:00:00' AND \"time\" < '2026-04-02 00:00:00'" in sql


def test_postgres_aggregate_breakdown_sql() -> None:
    adapter, conn = _pg()
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1 day",
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
        "1 hour",
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
    assert (
        "TIMESTAMP_BIN(INTERVAL 1 HOUR, `time`, TIMESTAMP '1970-01-01 00:00:00+00') AS _bucket"
        in sql
    )
    assert "`event_name`" in sql
    assert "GROUP BY _bucket" in sql
    assert "WHERE `time` >= TIMESTAMP '2026-04-01 00:00:00'" in sql


def test_bigquery_aggregate_breakdown_sql() -> None:
    adapter, client = _bq()
    adapter.get_time_bucketed_aggregate_breakdown(
        _BASE,
        "time",
        "1 day",
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


def test_clickhouse_aggregate_rejects_bad_interval() -> None:
    adapter, _ = _ch()
    with pytest.raises(ValueError, match="Unsupported interval"):
        adapter.get_time_bucketed_aggregate(
            _BASE,
            "time",
            "1; DROP TABLE x",
            MetricAggregation.sum,
            "amount",
            regular_columns=["event_name"],
            json_columns=[],
            json_value_paths=None,
            time_from=_FROM,
            time_to=_TO,
        )


def test_clickhouse_aggregate_breakdown_rejects_bad_interval() -> None:
    adapter, _ = _ch()
    with pytest.raises(ValueError, match="Unsupported interval"):
        adapter.get_time_bucketed_aggregate_breakdown(
            _BASE,
            "time",
            "1 fortnight",
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
        "1 day",
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
        "1 day",
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
