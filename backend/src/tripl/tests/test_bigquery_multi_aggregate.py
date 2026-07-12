from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime

import pytest

from tripl.core.adapters.base import AggregateSpec
from tripl.core.adapters.bigquery import BigQueryAdapter
from tripl.models.domain_enums import MetricAggregation

_FROM = datetime(2026, 4, 1, 0, 0)
_TO = datetime(2026, 4, 2, 0, 0)
_ALLOWED = {"time", "event_name", "amount", "user_id"}
_BASE = "SELECT time, event_name, amount, user_id FROM events"


# --- BigQuery fakes (mirror test_adapter_aggregations.py) -------------------


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
        # Seedable rows returned by every query(); drives the top-values
        # response that feeds Other-folding in the breakdown variant.
        self.rows: list[tuple[object, ...]] = []

    def query(self, sql: str) -> _BQJob:
        self.sql.append(sql)
        return _BQJob(self.rows)


def _bq(time_type: str = "TIMESTAMP") -> tuple[BigQueryAdapter, _BQClient]:
    client = _BQClient()
    adapter = object.__new__(BigQueryAdapter)
    adapter._client = client
    adapter._allowed_columns = set(_ALLOWED)
    # The bucket function and the window literal follow the column's declared type, so
    # the fake declares one. Pre-seeding also stops `_ensure_column_types` from firing
    # its own `LIMIT 0` schema probe ahead of the query under test at `client.sql[0]`.
    adapter._column_types = {"time": time_type, "event_name": "STRING", "amount": "FLOAT64"}
    adapter._struct_paths = {}
    return adapter, client


# `TIMESTAMP_BUCKET`, not the old `TIMESTAMP_BIN` — BIN is not a GoogleSQL function, so
# the previous form was a syntax error that never executed. Origin is the Unix epoch.
_BQ_BUCKET_1H = (
    "TIMESTAMP_BUCKET(`time`, INTERVAL 1 HOUR, "
    "TIMESTAMP '1970-01-01 00:00:00.000000+00:00') AS _bucket"
)
_BQ_WINDOW_LOWER = "WHERE `time` >= TIMESTAMP '2026-04-01 00:00:00.000000+00:00'"


# --- multi-aggregate: one scan, many aggregates -----------------------------


def test_multi_aggregate_select_shape() -> None:
    adapter, client = _bq()
    specs = [
        AggregateSpec(key="k_cnt", aggregation=MetricAggregation.count),
        AggregateSpec(key="k_sum", aggregation=MetricAggregation.sum, column="amount"),
        AggregateSpec(key="k_dist", aggregation=MetricAggregation.count_distinct, column="user_id"),
    ]
    names, _ = adapter.get_time_bucketed_multi_aggregate(
        _BASE,
        "time",
        "1h",
        specs,
        _FROM,
        _TO,
    )
    assert names == ["bucket", "k_cnt", "k_sum", "k_dist"]
    sql = client.sql[0]
    # One scan: a single SELECT wrapping the source base query.
    assert sql.count("FROM (SELECT time") == 1
    assert "count(*) AS `k_cnt`" in sql
    assert "sum(`amount`) AS `k_sum`" in sql
    assert "count(DISTINCT `user_id`) AS `k_dist`" in sql
    assert _BQ_BUCKET_1H in sql
    assert "TIMESTAMP_BIN" not in sql
    assert "GROUP BY _bucket" in sql
    assert "ORDER BY _bucket" in sql
    assert _BQ_WINDOW_LOWER in sql


def test_multi_aggregate_conditional_filter_folds_into_case() -> None:
    adapter, client = _bq()
    specs = [
        AggregateSpec(
            key="k_cnt_f",
            aggregation=MetricAggregation.count,
            filter_sql="`amount` > 10",
        ),
        AggregateSpec(
            key="k_sum_f",
            aggregation=MetricAggregation.sum,
            column="amount",
            filter_sql="`event_name` = 'buy'",
        ),
        AggregateSpec(
            key="k_dist_f",
            aggregation=MetricAggregation.count_distinct,
            column="user_id",
            filter_sql="`amount` > 0",
        ),
    ]
    adapter.get_time_bucketed_multi_aggregate(_BASE, "time", "1d", specs, _FROM, _TO)
    sql = client.sql[0]
    # BigQuery has no FILTER (WHERE ...); conditions fold into CASE / IF forms.
    assert "FILTER (WHERE" not in sql
    # count / count_distinct return 0 (not NULL) for an empty group, so they are
    # NULLIF-wrapped to read as absent — matching the per-metric path. sum (and
    # avg/min/max) over CASE WHEN already return NULL, so they stay unwrapped.
    assert "NULLIF(count(CASE WHEN `amount` > 10 THEN 1 END), 0) AS `k_cnt_f`" in sql
    assert "sum(CASE WHEN `event_name` = 'buy' THEN `amount` END) AS `k_sum_f`" in sql
    assert ("NULLIF(count(DISTINCT IF(`amount` > 0, `user_id`, NULL)), 0) AS `k_dist_f`") in sql


@pytest.mark.parametrize(
    ("agg", "column", "expected"),
    [
        (MetricAggregation.count, None, "count(*) AS `k`"),
        (MetricAggregation.sum, "amount", "sum(`amount`) AS `k`"),
        (MetricAggregation.avg, "amount", "avg(`amount`) AS `k`"),
        (MetricAggregation.min, "amount", "min(`amount`) AS `k`"),
        (MetricAggregation.max, "amount", "max(`amount`) AS `k`"),
        (MetricAggregation.count_distinct, "user_id", "count(DISTINCT `user_id`) AS `k`"),
    ],
)
def test_multi_aggregate_unfiltered_matches_single_path(
    agg: MetricAggregation, column: str | None, expected: str
) -> None:
    adapter, client = _bq()
    adapter.get_time_bucketed_multi_aggregate(
        _BASE,
        "time",
        "1h",
        [AggregateSpec(key="k", aggregation=agg, column=column)],
        _FROM,
        _TO,
    )
    assert expected in client.sql[0]


def test_multi_aggregate_empty_specs_returns_header_only() -> None:
    adapter, client = _bq()
    names, rows = adapter.get_time_bucketed_multi_aggregate(
        _BASE,
        "time",
        "1h",
        [],
        _FROM,
        _TO,
    )
    assert names == ["bucket"]
    assert rows == []
    assert client.sql == []


def test_multi_aggregate_rejects_unknown_measure() -> None:
    adapter, _ = _bq()
    with pytest.raises(ValueError, match="not found in query result"):
        adapter.get_time_bucketed_multi_aggregate(
            _BASE,
            "time",
            "1h",
            [AggregateSpec(key="k", aggregation=MetricAggregation.sum, column="revenue")],
            _FROM,
            _TO,
        )


def test_multi_aggregate_rejects_bad_alias() -> None:
    adapter, _ = _bq()
    with pytest.raises(ValueError, match="Invalid aggregate key alias"):
        adapter.get_time_bucketed_multi_aggregate(
            _BASE,
            "time",
            "1h",
            [AggregateSpec(key="bad alias`", aggregation=MetricAggregation.count)],
            _FROM,
            _TO,
        )


@pytest.mark.parametrize("bad", ["1; DROP TABLE x", "1 fortnight", "1 hour", "1 month"])
def test_multi_aggregate_rejects_bad_interval(bad: str) -> None:
    adapter, _ = _bq()
    with pytest.raises(ValueError, match="Unknown interval code"):
        adapter.get_time_bucketed_multi_aggregate(
            _BASE,
            "time",
            bad,
            [AggregateSpec(key="k", aggregation=MetricAggregation.count)],
            _FROM,
            _TO,
        )


def test_multi_aggregate_datetime_column_uses_datetime_bucket() -> None:
    # The bucket function follows the column's *declared* type family: GoogleSQL
    # rejects a TIMESTAMP_* function applied to a DATETIME column, so a DATETIME time
    # column must bucket (and compare) zone-lessly.
    adapter, client = _bq(time_type="DATETIME")
    adapter.get_time_bucketed_multi_aggregate(
        _BASE,
        "time",
        "1h",
        [AggregateSpec(key="k", aggregation=MetricAggregation.count)],
        _FROM,
        _TO,
    )
    sql = client.sql[0]
    assert (
        "DATETIME_BUCKET(`time`, INTERVAL 1 HOUR, DATETIME '1970-01-01 00:00:00.000000') AS _bucket"
    ) in sql
    assert "WHERE `time` >= DATETIME '2026-04-01 00:00:00.000000'" in sql
    assert "TIMESTAMP" not in sql


def test_multi_aggregate_date_column_rejects_sub_day_interval() -> None:
    # A DATE column has no time-of-day, so a sub-day bucket is a configuration error
    # surfaced now rather than silently rounded.
    adapter, _ = _bq(time_type="DATE")
    with pytest.raises(ValueError, match="which has no |no time-of-day"):
        adapter.get_time_bucketed_multi_aggregate(
            _BASE,
            "time",
            "15m",
            [AggregateSpec(key="k", aggregation=MetricAggregation.count)],
            _FROM,
            _TO,
        )


# --- multi-aggregate breakdown variant --------------------------------------


def test_multi_aggregate_breakdown_select_shape() -> None:
    adapter, client = _bq()
    specs = [
        AggregateSpec(key="k_cnt", aggregation=MetricAggregation.count),
        AggregateSpec(key="k_max", aggregation=MetricAggregation.max, column="amount"),
    ]
    names, _ = adapter.get_time_bucketed_multi_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        "event_name",
        specs,
        _FROM,
        _TO,
    )
    assert names == ["bucket", "breakdown_value", "is_other", "k_cnt", "k_max"]
    sql = client.sql[0]
    assert "IFNULL(CAST(`event_name` AS STRING), '') AS _breakdown_value" in sql
    assert "0 AS _is_other" in sql
    assert "count(*) AS `k_cnt`" in sql
    assert "max(`amount`) AS `k_max`" in sql
    assert "GROUP BY _bucket, _breakdown_value, _is_other" in sql
    assert "ORDER BY _bucket, _breakdown_value" in sql


def test_multi_aggregate_breakdown_folds_other_with_limit() -> None:
    adapter, client = _bq()
    # Seed the top-values scan so Other-folding takes the IN (...) branch.
    client.rows = [("event_name", "click"), ("event_name", "view")]
    adapter.get_time_bucketed_multi_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        "event_name",
        [AggregateSpec(key="k_cnt", aggregation=MetricAggregation.count)],
        _FROM,
        _TO,
        values_limit=3,
    )
    sql = client.sql[-1]
    assert "CASE WHEN" in sql
    assert "IN (" in sql
    assert "ELSE 'Other'" in sql


def test_multi_aggregate_breakdown_conditional_filter() -> None:
    adapter, client = _bq()
    adapter.get_time_bucketed_multi_aggregate_breakdown(
        _BASE,
        "time",
        "1d",
        "event_name",
        [
            AggregateSpec(
                key="k_sum_f",
                aggregation=MetricAggregation.sum,
                column="amount",
                filter_sql="`amount` > 0",
            )
        ],
        _FROM,
        _TO,
    )
    sql = client.sql[0]
    assert "sum(CASE WHEN `amount` > 0 THEN `amount` END) AS `k_sum_f`" in sql
