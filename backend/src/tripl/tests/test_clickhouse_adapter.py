from __future__ import annotations

from datetime import datetime

import pytest

from tripl.core.adapters.base import AggregateSpec
from tripl.core.adapters.clickhouse import ClickHouseAdapter
from tripl.models.domain_enums import MetricAggregation

# Window bounds are rendered by `bucketing.format_utc_literal` and parsed with an
# explicit UTC result zone, so an offset-less literal can no longer be reinterpreted
# in the column's timezone.
_WINDOW = (
    "WHERE `time` >= parseDateTime64BestEffort('2026-04-01 00:00:00.000000+00:00', 6, 'UTC') "
    "AND `time` < parseDateTime64BestEffort('2026-04-02 00:00:00.000000+00:00', 6, 'UTC')"
)


class FakeQueryResult:
    column_names = ["event_name"]
    result_rows: list[tuple[object, ...]] = []


class FakeClient:
    def __init__(self) -> None:
        self.sql: list[str] = []

    def query(self, sql: str) -> FakeQueryResult:
        self.sql.append(sql)
        return FakeQueryResult()


def _adapter(json_path_discovery: str = "dynamic") -> tuple[ClickHouseAdapter, FakeClient]:
    client = FakeClient()
    adapter = object.__new__(ClickHouseAdapter)
    adapter._client = client
    adapter._allowed_columns = {"time", "event_name", "props", "tuple_props", "map_props"}
    adapter._column_types = {
        "time": "DateTime64(6, 'UTC')",
        "event_name": "String",
        "props": "JSON",
        "tuple_props": "Tuple(user Tuple(id UInt64, address Tuple(city String)))",
        "map_props": "Map(String, String)",
    }
    adapter._tuple_leaf_paths_cache = {}
    adapter._json_path_discovery = json_path_discovery
    return adapter, client


def test_clickhouse_preview_rows_applies_time_window() -> None:
    adapter, client = _adapter()

    adapter.get_preview_rows(
        "SELECT time, event_name FROM events",
        limit=5,
        time_column="time",
        time_from=datetime(2026, 4, 1, 0, 0),
        time_to=datetime(2026, 4, 2, 0, 0),
    )

    assert (f"FROM (SELECT time, event_name FROM events) AS _src {_WINDOW} LIMIT 5") in client.sql[
        0
    ]


def test_clickhouse_full_breakdown_applies_time_window() -> None:
    adapter, client = _adapter()

    adapter.get_full_breakdown(
        "SELECT time, event_name FROM events",
        regular_columns=["event_name"],
        json_columns=[],
        time_column="time",
        time_from=datetime(2026, 4, 1, 0, 0),
        time_to=datetime(2026, 4, 2, 0, 0),
        limit=11,
    )

    assert (
        f"FROM (SELECT time, event_name FROM events) AS _src {_WINDOW} GROUP BY ALL"
    ) in client.sql[0]


def test_json_path_discovery_defaults_to_dynamic_function() -> None:
    adapter, client = _adapter()  # default mode
    adapter.get_json_path_samples("SELECT props FROM events", ["props"])
    assert "JSONDynamicPaths(`props`)" in client.sql[0]
    assert "JSONAllPaths" not in client.sql[0]


def test_json_path_discovery_all_uses_jsonallpaths() -> None:
    adapter, client = _adapter(json_path_discovery="all")
    adapter.get_json_path_samples("SELECT props FROM events", ["props"])
    assert "JSONAllPaths(`props`)" in client.sql[0]
    assert "JSONDynamicPaths" not in client.sql[0]


def test_named_tuple_paths_use_declared_leaf_names_and_tuple_element_access() -> None:
    adapter, _client = _adapter()

    assert adapter._nested_path_array_expression("tuple_props") == (  # noqa: SLF001
        "arraySort(tupleNames(flattenTuple(`tuple_props`)))"
    )
    assert adapter._json_path_expression(  # noqa: SLF001
        "tuple_props", "user.address.city"
    ) == ("tupleElement(tupleElement(tupleElement(`tuple_props`, 'user'), 'address'), 'city')")


def test_string_map_paths_discover_keys_and_preserve_missing_as_null() -> None:
    adapter, _client = _adapter()

    assert adapter._nested_path_array_expression("map_props") == (  # noqa: SLF001
        "arraySort(arrayDistinct(arrayFilter(_path -> match(_path, "
        "'^[a-zA-Z_][a-zA-Z0-9_]*$'), mapKeys(`map_props`))))"
    )
    assert adapter._json_path_expression("map_props", "campaign") == (  # noqa: SLF001
        "if(mapContains(`map_props`, 'campaign'), `map_props`['campaign'], NULL)"
    )


def test_map_paths_reject_non_string_keys_and_nested_values() -> None:
    adapter, _client = _adapter()
    adapter._column_types = {  # noqa: SLF001
        **adapter._column_types,  # noqa: SLF001
        "map_props": "Map(UInt64, String)",
    }

    with pytest.raises(ValueError, match="String keys"):
        adapter._nested_path_array_expression("map_props")  # noqa: SLF001

    adapter._column_types = {  # noqa: SLF001
        **adapter._column_types,  # noqa: SLF001
        "map_props": "Map(String, Tuple(value String))",
    }
    with pytest.raises(ValueError, match="scalar values"):
        adapter._json_path_expression("map_props", "campaign")  # noqa: SLF001


def test_unnamed_tuple_paths_are_rejected() -> None:
    adapter, _client = _adapter()
    adapter._column_types = {  # noqa: SLF001
        **adapter._column_types,  # noqa: SLF001
        "tuple_props": "Tuple(String, UInt64)",
    }

    with pytest.raises(ValueError, match="named fields"):
        adapter._nested_path_array_expression("tuple_props")  # noqa: SLF001


def test_tuple_schema_is_cached_and_bounded() -> None:
    adapter, _client = _adapter()

    first = adapter._tuple_leaf_paths("tuple_props")  # noqa: SLF001
    second = adapter._tuple_leaf_paths("tuple_props")  # noqa: SLF001
    assert first is second

    nested = "String"
    for depth in range(21, 0, -1):
        nested = f"Tuple(level_{depth} {nested})"
    adapter._column_types = {  # noqa: SLF001
        **adapter._column_types,  # noqa: SLF001
        "tuple_props": nested,
    }
    adapter._tuple_leaf_paths_cache = {}  # noqa: SLF001
    with pytest.raises(ValueError, match="nesting exceeds 20"):
        adapter._tuple_leaf_paths("tuple_props")  # noqa: SLF001

    fields = ", ".join(f"field_{index} String" for index in range(1001))
    adapter._column_types = {  # noqa: SLF001
        **adapter._column_types,  # noqa: SLF001
        "tuple_props": f"Tuple({fields})",
    }
    adapter._tuple_leaf_paths_cache = {}  # noqa: SLF001
    with pytest.raises(ValueError, match="more than 1000 leaf fields"):
        adapter._tuple_leaf_paths("tuple_props")  # noqa: SLF001


_FROM = datetime(2026, 4, 1, 0, 0)
_TO = datetime(2026, 4, 2, 0, 0)


def test_multi_aggregate_emits_one_column_per_spec() -> None:
    adapter, client = _adapter()

    col_names, _rows = adapter.get_time_bucketed_multi_aggregate(
        "SELECT time, event_name FROM events",
        time_column="time",
        interval="1d",
        specs=[
            AggregateSpec(key="k_count", aggregation=MetricAggregation.count),
            AggregateSpec(key="k_sum", aggregation=MetricAggregation.sum, column="event_name"),
            AggregateSpec(
                key="k_distinct",
                aggregation=MetricAggregation.count_distinct,
                column="event_name",
            ),
        ],
        time_from=_FROM,
        time_to=_TO,
    )

    sql = client.sql[0]
    # One scan, bucket + one aliased aggregate column per spec.
    assert "toStartOfInterval(`time`, INTERVAL 1 DAY, 'UTC') AS _bucket" in sql
    assert "count(*) AS `k_count`" in sql
    assert "sum(`event_name`) AS `k_sum`" in sql
    assert "count(DISTINCT `event_name`) AS `k_distinct`" in sql
    assert (
        f"FROM (SELECT time, event_name FROM events) AS _src {_WINDOW} "
        "GROUP BY _bucket ORDER BY _bucket"
    ) in sql
    assert col_names == ["bucket", "k_count", "k_sum", "k_distinct"]


def test_multi_aggregate_sql_can_be_built_without_executing_query() -> None:
    adapter, client = _adapter()

    col_names, sql = adapter.build_time_bucketed_multi_aggregate_sql(
        "SELECT time, event_name FROM events",
        time_column="time",
        interval="1d",
        specs=[
            AggregateSpec(key="k_count", aggregation=MetricAggregation.count),
            AggregateSpec(
                key="k_filtered",
                aggregation=MetricAggregation.count,
                filter_sql="event_name = 'signup'",
            ),
        ],
        time_from=_FROM,
        time_to=_TO,
    )

    assert col_names == ["bucket", "k_count", "k_filtered"]
    assert "count(*) AS `k_count`" in sql
    assert "countIf(event_name = 'signup')" in sql
    assert client.sql == []


def test_multi_aggregate_conditional_filter_uses_if_variants() -> None:
    adapter, client = _adapter()

    adapter.get_time_bucketed_multi_aggregate(
        "SELECT time, event_name FROM events",
        time_column="time",
        interval="1h",
        specs=[
            AggregateSpec(
                key="k_cf",
                aggregation=MetricAggregation.count,
                filter_sql="event_name = 'signup'",
            ),
            AggregateSpec(
                key="k_sf",
                aggregation=MetricAggregation.sum,
                column="event_name",
                filter_sql="event_name = 'signup'",
            ),
            AggregateSpec(
                key="k_df",
                aggregation=MetricAggregation.count_distinct,
                column="event_name",
                filter_sql="event_name = 'signup'",
            ),
        ],
        time_from=_FROM,
        time_to=_TO,
    )

    sql = client.sql[0]
    # Conditional aggregates are NULL-guarded: a bucket with rows but none
    # matching the filter reads as NULL (absent), matching the per-metric path
    # rather than ClickHouse's -If numeric default (0) or type extreme / NaN.
    assert (
        "if(countIf(event_name = 'signup') = 0, NULL, countIf(event_name = 'signup')) AS `k_cf`"
    ) in sql
    assert (
        "if(countIf(event_name = 'signup') = 0, NULL, "
        "sumIf(`event_name`, event_name = 'signup')) AS `k_sf`"
    ) in sql
    assert (
        "if(countIf(event_name = 'signup') = 0, NULL, "
        "uniqExactIf(`event_name`, event_name = 'signup')) AS `k_df`"
    ) in sql


def test_multi_aggregate_breakdown_shape_and_other_folding() -> None:
    adapter, client = _adapter()

    col_names, _rows = adapter.get_time_bucketed_multi_aggregate_breakdown(
        "SELECT time, event_name FROM events",
        time_column="time",
        interval="1d",
        breakdown_column="event_name",
        specs=[
            AggregateSpec(key="k_count", aggregation=MetricAggregation.count),
            AggregateSpec(key="k_sum", aggregation=MetricAggregation.sum, column="event_name"),
        ],
        time_from=_FROM,
        time_to=_TO,
        values_limit=5,
    )

    # values_limit set => a top-values query runs first, then the breakdown query.
    breakdown_sql = client.sql[-1]
    assert "toStartOfInterval(`time`, INTERVAL 1 DAY, 'UTC') AS _bucket" in breakdown_sql
    assert "AS _breakdown_value" in breakdown_sql
    assert "AS _is_other" in breakdown_sql
    assert "count(*) AS `k_count`" in breakdown_sql
    assert "sum(`event_name`) AS `k_sum`" in breakdown_sql
    assert "GROUP BY ALL ORDER BY _bucket, _breakdown_value" in breakdown_sql
    # FakeClient returns no top values, so every value folds into 'Other'.
    assert "'Other' AS _breakdown_value" in breakdown_sql
    assert "1 AS _is_other" in breakdown_sql
    assert col_names == ["bucket", "breakdown_value", "is_other", "k_count", "k_sum"]


def test_multi_aggregate_breakdown_no_limit_skips_other_folding() -> None:
    adapter, client = _adapter()

    adapter.get_time_bucketed_multi_aggregate_breakdown(
        "SELECT time, event_name FROM events",
        time_column="time",
        interval="1d",
        breakdown_column="event_name",
        specs=[AggregateSpec(key="k_count", aggregation=MetricAggregation.count)],
        time_from=_FROM,
        time_to=_TO,
        values_limit=None,
    )

    # No values_limit => no top-values pre-query, raw value, never "Other".
    assert len(client.sql) == 1
    sql = client.sql[0]
    assert "ifNull(toString(`event_name`), '') AS _breakdown_value" in sql
    assert "0 AS _is_other" in sql


def test_json_path_discovery_init_resolves_mode() -> None:
    import tripl.core.adapters.clickhouse as ch_mod

    original = ch_mod.clickhouse_connect.get_client
    ch_mod.clickhouse_connect.get_client = lambda **_kwargs: FakeClient()  # type: ignore[assignment]

    def _mode(value: str | None) -> str:
        adapter = ClickHouseAdapter(host="h", port=1, database="d", json_path_discovery=value)
        return adapter._json_path_discovery

    try:
        # Unset and unknown both fall back to the default ("dynamic"); "all" sticks.
        assert _mode(None) == "dynamic"
        assert _mode("bogus") == "dynamic"
        assert _mode("all") == "all"
    finally:
        ch_mod.clickhouse_connect.get_client = original  # type: ignore[assignment]
