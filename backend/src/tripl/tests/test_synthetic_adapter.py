"""Contract tests for the local synthetic warehouse adapter (tripl-2su6.3).

The synthetic adapter serves a bounded, deterministic in-memory dataset and must
honour the same return shapes as the real warehouse adapters (ClickHouse /
Postgres / BigQuery) so the normal preview / scan / collect paths run unchanged —
with NO network or filesystem access.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from tripl.core.adapters.base import AggregateSpec
from tripl.core.adapters.synthetic import (
    SYNTHETIC_MAX_ROWS,
    SyntheticAdapter,
    SyntheticCapabilityError,
)
from tripl.models.domain_enums import MetricAggregation as MA

ANCHOR = datetime(2026, 6, 1, tzinfo=UTC)
HISTORY_DAYS = 30
SEED = 7

# A window comfortably wider than the whole dataset.
FULL_FROM = ANCHOR - timedelta(days=HISTORY_DAYS + 5)
FULL_TO = ANCHOR + timedelta(days=2)


def _adapter(seed: int = SEED) -> SyntheticAdapter:
    return SyntheticAdapter(seed=seed, anchor=ANCHOR, history_days=HISTORY_DAYS)


def _day(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


# --------------------------------------------------------------------------- #
# schema / columns / preview
# --------------------------------------------------------------------------- #


def test_schema_tables_lists_events_and_orders() -> None:
    tables = {t.name: [c.name for c in t.columns] for t in _adapter().get_schema_tables()}
    assert set(tables) == {"events", "orders"}
    assert tables["events"][0] == "event_time"
    assert "session_id" in tables["events"]
    assert tables["orders"] == [
        "created_at",
        "amount",
        "currency",
        "user_id",
        "country",
        "status",
    ]


def test_get_columns_selects_table_from_query() -> None:
    adapter = _adapter()
    orders_cols = [c.name for c in adapter.get_columns("SELECT * FROM orders")]
    assert orders_cols == ["created_at", "amount", "currency", "user_id", "country", "status"]
    # get_columns records the allowlist for downstream measure validation.
    assert adapter._allowed_columns == set(orders_cols)

    event_cols = [c.name for c in adapter.get_columns("SELECT * FROM events")]
    assert "session_id" in event_cols and "platform" in event_cols


def test_preview_rows_returns_scan_rows_within_window() -> None:
    adapter = _adapter()
    cols, rows = adapter.get_preview_rows(
        "SELECT * FROM events",
        limit=5,
        time_column="event_time",
        time_from=ANCHOR - timedelta(days=3),
        time_to=ANCHOR,
    )
    assert cols[0] == "event_time"
    assert len(rows) == 5  # honours the limit
    time_idx = cols.index("event_time")
    for row in rows:
        assert ANCHOR - timedelta(days=3) <= row[time_idx] < ANCHOR


def test_preview_time_window_is_a_strict_subset() -> None:
    adapter = _adapter()
    _, wide = adapter.get_preview_rows(
        "SELECT * FROM events", limit=100000, time_column="event_time",
        time_from=FULL_FROM, time_to=FULL_TO,
    )
    _, narrow = adapter.get_preview_rows(
        "SELECT * FROM events", limit=100000, time_column="event_time",
        time_from=ANCHOR - timedelta(days=2), time_to=ANCHOR,
    )
    assert 0 < len(narrow) < len(wide)


# --------------------------------------------------------------------------- #
# sql-metric support + capability errors
# --------------------------------------------------------------------------- #

_ACTIVE_SESSIONS_SQL = (
    "SELECT toStartOfDay(event_time) AS ts, count(DISTINCT session_id) AS value FROM events"
)


def test_active_sessions_sql_metric_computes_distinct_sessions_per_day() -> None:
    adapter = _adapter()
    cols, rows = adapter.get_preview_rows(
        _ACTIVE_SESSIONS_SQL,
        limit=1000,
        time_column="ts",
        time_from=ANCHOR - timedelta(days=7),
        time_to=ANCHOR,
    )
    assert cols == ["ts", "value"]
    assert len(rows) == 7  # one row per day in the 7-day window
    for ts, value in rows:
        assert ts == _day(ts)  # day-aligned buckets
        assert ANCHOR - timedelta(days=7) <= ts < ANCHOR
        assert isinstance(value, int) and value > 0

    # Independently verify the newest day's distinct-session count.
    newest = max(ts for ts, _ in rows)
    expected = len(
        {r["session_id"] for r in adapter._events if _day(r["event_time"]) == newest}
    )
    assert dict(rows)[newest] == expected


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT count(*) AS value, ts FROM events GROUP BY ts",
        "SELECT a.id FROM events a JOIN orders b ON a.user_id = b.user_id",
        "SELECT sum(amount) AS value, day AS ts FROM orders GROUP BY day",
        "SELECT DISTINCT platform FROM events",
    ],
)
def test_unsupported_sql_raises_capability_error(sql: str) -> None:
    # Unsupported SQL must raise — never fabricate a fallback result.
    with pytest.raises(SyntheticCapabilityError):
        _adapter().get_preview_rows(sql, time_column="ts")


# --------------------------------------------------------------------------- #
# time-bucketed counts + breakdowns
# --------------------------------------------------------------------------- #


def test_time_bucketed_counts_sum_to_windowed_rows() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=3), ANCHOR
    col_names, json_names, rows = adapter.get_time_bucketed_counts(
        "SELECT * FROM events", "event_time", "1 DAY", ["event_type"], [], None, tf, tt
    )
    assert col_names == ["event_type"]
    assert json_names == []
    # Row layout: (_bucket, event_type, count). Counts sum to the events in window.
    expected = sum(1 for r in adapter._events if tf <= r["event_time"] < tt)
    assert sum(row[-1] for row in rows) == expected
    for bucket, _et, count in rows:
        assert bucket == _day(bucket) and count > 0


def test_bucketed_breakdown_counts_topn_folds_other() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=5), ANCHOR
    _cols, _json, rows = adapter.get_time_bucketed_breakdown_counts(
        "SELECT * FROM events", "event_time", "1 DAY", "platform", [], [], None,
        tf, tt, values_limit=2,
    )
    # Row layout: (_bucket, breakdown_value, is_other, count).
    non_other = {r[1] for r in rows if r[2] == 0}
    assert len(non_other) <= 1  # top (values_limit - 1) kept
    assert all(r[2] in (0, 1) for r in rows)
    assert any(r[2] == 1 for r in rows)  # platform has 3 values -> some fold to Other
    assert all(r[1] == "Other" for r in rows if r[2] == 1)


def test_bucketed_breakdown_counts_multi_covers_each_column() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=3), ANCHOR
    _cols, _json, rows = adapter.get_time_bucketed_breakdown_counts_multi(
        "SELECT * FROM events", "event_time", "1 DAY",
        ["platform", "event_type"], [], [], None, tf, tt,
    )
    # Row layout: (_bucket, breakdown_column, breakdown_value, is_other, count).
    assert {r[1] for r in rows} == {"platform", "event_type"}
    # Each breakdown column's counts independently sum to the windowed row total.
    expected = sum(1 for r in adapter._events if tf <= r["event_time"] < tt)
    for column in ("platform", "event_type"):
        assert sum(r[-1] for r in rows if r[1] == column) == expected


# --------------------------------------------------------------------------- #
# time-bucketed aggregates
# --------------------------------------------------------------------------- #


def _orders_in(adapter: SyntheticAdapter, tf: datetime, tt: datetime) -> list[dict]:
    return [r for r in adapter._orders if tf <= r["created_at"] < tt]


def test_bucketed_aggregate_sum_matches_manual() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=6), ANCHOR
    _cols, _json, rows = adapter.get_time_bucketed_aggregate(
        "SELECT * FROM orders", "created_at", "1 DAY", MA.sum, "amount", [], [], None, tf, tt
    )
    got = {bucket: value for bucket, value in rows}
    manual: dict[datetime, float] = {}
    for r in _orders_in(adapter, tf, tt):
        manual[_day(r["created_at"])] = manual.get(_day(r["created_at"]), 0.0) + r["amount"]
    assert set(got) == set(manual)
    for bucket, total in manual.items():
        assert got[bucket] == pytest.approx(total)


def test_bucketed_aggregate_count_avg_and_count_distinct() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=4), ANCHOR
    orders = _orders_in(adapter, tf, tt)

    _c, _j, count_rows = adapter.get_time_bucketed_aggregate(
        "SELECT * FROM orders", "created_at", "1 DAY", MA.count, None, [], [], None, tf, tt
    )
    assert sum(r[-1] for r in count_rows) == len(orders)

    _c, _j, avg_rows = adapter.get_time_bucketed_aggregate(
        "SELECT * FROM orders", "created_at", "1 DAY", MA.avg, "amount", [], [], None, tf, tt
    )
    for bucket, value in avg_rows:
        day_orders = [r["amount"] for r in orders if _day(r["created_at"]) == bucket]
        assert value == pytest.approx(sum(day_orders) / len(day_orders))

    _c, _j, distinct_rows = adapter.get_time_bucketed_aggregate(
        "SELECT * FROM orders", "created_at", "1 DAY", MA.count_distinct, "user_id",
        [], [], None, tf, tt,
    )
    for bucket, value in distinct_rows:
        day_users = {r["user_id"] for r in orders if _day(r["created_at"]) == bucket}
        assert value == len(day_users)


def test_aggregate_breakdown_folds_other_and_sums() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=8), ANCHOR
    _c, _j, rows = adapter.get_time_bucketed_aggregate_breakdown(
        "SELECT * FROM orders", "created_at", "1 DAY", MA.sum, "amount", "country",
        [], [], None, tf, tt, values_limit=3,
    )
    # Row layout: (_bucket, breakdown_value, is_other, aggregate_value).
    assert all(r[2] in (0, 1) for r in rows)
    non_other = {r[1] for r in rows if r[2] == 0}
    assert len(non_other) <= 2  # values_limit - 1
    # Each bucket's per-breakdown sums reconstruct the bucket's total order amount.
    per_bucket_total: dict[datetime, float] = {}
    for r in _orders_in(adapter, tf, tt):
        per_bucket_total[_day(r["created_at"])] = (
            per_bucket_total.get(_day(r["created_at"]), 0.0) + r["amount"]
        )
    summed: dict[datetime, float] = {}
    for bucket, _value, _is_other, agg in rows:
        summed[bucket] = summed.get(bucket, 0.0) + agg
    for bucket, total in per_bucket_total.items():
        assert summed[bucket] == pytest.approx(total)


def test_multi_aggregate_one_scan_many_specs() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=5), ANCHOR
    specs = [
        AggregateSpec(key="rev", aggregation=MA.sum, column="amount"),
        AggregateSpec(key="cnt", aggregation=MA.count),
    ]
    col_names, rows = adapter.get_time_bucketed_multi_aggregate(
        "SELECT * FROM orders", "created_at", "1 DAY", specs, tf, tt
    )
    assert col_names == ["bucket", "rev", "cnt"]
    for bucket, rev, cnt in rows:
        day_orders = [r for r in _orders_in(adapter, tf, tt) if _day(r["created_at"]) == bucket]
        assert cnt == len(day_orders)
        assert rev == pytest.approx(sum(r["amount"] for r in day_orders))


def test_multi_aggregate_breakdown_with_filter_and_null_sentinel() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=10), ANCHOR
    specs = [
        AggregateSpec(
            key="rev", aggregation=MA.sum, column="amount", filter_sql="status = 'completed'"
        ),
        AggregateSpec(key="cnt", aggregation=MA.count),
    ]
    col_names, rows = adapter.get_time_bucketed_multi_aggregate_breakdown(
        "SELECT * FROM orders", "created_at", "1 DAY", "country", specs, tf, tt, values_limit=4
    )
    assert col_names == ["bucket", "breakdown_value", "is_other", "rev", "cnt"]
    # 'Other' folds the countries outside the top (values_limit - 1) by row count.
    windowed = _orders_in(adapter, tf, tt)
    top = adapter._top_values(windowed, "country", 4)
    assert top is not None and len(top) <= 3
    for bucket, value, is_other, rev, cnt in rows:
        group = [
            r
            for r in windowed
            if _day(r["created_at"]) == bucket
            and (r["country"] not in top if is_other else r["country"] == value)
        ]
        assert cnt == len(group)
        completed = [r["amount"] for r in group if r["status"] == "completed"]
        if completed:
            assert rev == pytest.approx(sum(completed))
        else:
            # No matching rows -> NULL sentinel, matching the ClickHouse path.
            assert rev is None


def test_unsupported_filter_sql_raises_capability_error() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=5), ANCHOR
    specs = [
        AggregateSpec(
            key="x",
            aggregation=MA.count,
            filter_sql="user_id IN (SELECT user_id FROM orders)",
        )
    ]
    with pytest.raises(SyntheticCapabilityError):
        adapter.get_time_bucketed_multi_aggregate(
            "SELECT * FROM orders", "created_at", "1 DAY", specs, tf, tt
        )


# --------------------------------------------------------------------------- #
# limits / determinism / isolation / safety
# --------------------------------------------------------------------------- #


def test_row_limit_and_time_window_are_honoured() -> None:
    adapter = _adapter()
    _cols, rows = adapter.get_preview_rows(
        "SELECT * FROM orders", limit=3, time_column="created_at",
        time_from=FULL_FROM, time_to=FULL_TO,
    )
    assert len(rows) == 3

    # A window before any data yields nothing (no fabrication).
    _cols, empty = adapter.get_preview_rows(
        "SELECT * FROM events", limit=100, time_column="event_time",
        time_from=ANCHOR - timedelta(days=400), time_to=ANCHOR - timedelta(days=390),
    )
    assert empty == []


def test_dataset_is_bounded() -> None:
    adapter = _adapter()
    assert 0 < len(adapter._events) <= SYNTHETIC_MAX_ROWS
    assert 0 < len(adapter._orders) <= SYNTHETIC_MAX_ROWS


def test_determinism_same_seed_and_anchor_are_identical() -> None:
    a, b = _adapter(), _adapter()
    assert a._events == b._events
    assert a._orders == b._orders
    # Identical method output too, not just identical raw data.
    tf, tt = ANCHOR - timedelta(days=5), ANCHOR
    args = ("SELECT * FROM orders", "created_at", "1 DAY", MA.sum, "amount", [], [], None, tf, tt)
    assert a.get_time_bucketed_aggregate(*args) == b.get_time_bucketed_aggregate(*args)


def test_isolation_between_two_synthetic_sources() -> None:
    # Two demo projects -> two sources with distinct seeds -> independent datasets.
    a, b = _adapter(seed=101), _adapter(seed=202)
    assert a._orders != b._orders
    _c, rows_a = a.get_preview_rows("SELECT * FROM orders", limit=100000, time_column="created_at",
                                    time_from=FULL_FROM, time_to=FULL_TO)
    _c, rows_b = b.get_preview_rows("SELECT * FROM orders", limit=100000, time_column="created_at",
                                    time_from=FULL_FROM, time_to=FULL_TO)
    assert rows_a != rows_b
    # Each source stays internally consistent (re-query is stable).
    _c, rows_a2 = a.get_preview_rows("SELECT * FROM orders", limit=100000, time_column="created_at",
                                     time_from=FULL_FROM, time_to=FULL_TO)
    assert rows_a == rows_a2


def test_test_connection_is_local_and_close_is_noop() -> None:
    adapter = _adapter()
    # Honest local check — no host contacted — and close never raises.
    assert adapter.test_connection() is True
    assert adapter.close() is None


def test_unknown_column_is_rejected() -> None:
    adapter = _adapter()
    tf, tt = ANCHOR - timedelta(days=2), ANCHOR
    with pytest.raises(ValueError, match="not found"):
        adapter.get_time_bucketed_counts(
            "SELECT * FROM events", "event_time", "1 DAY", ["nope"], [], None, tf, tt
        )
