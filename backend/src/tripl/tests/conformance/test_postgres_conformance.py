"""Gate 1: the real PostgresAdapter against a real ``postgres:18``.

The SQL is EXECUTED, and the rows that come back are compared against
``tripl.core.bucketing.floor_to_bucket`` — the reference implementation of the
bucket contract. A string assertion cannot tell you that ``date_bin`` binned from
the right origin; running it can.

PostgreSQL >= 14 is required (``date_bin``), and ``PostgresAdapter.test_connection``
now refuses anything older, so the version guard is exercised here too.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

import psycopg
import pytest

from tripl.core.adapters.base import AggregateSpec
from tripl.core.adapters.postgres import PostgresAdapter
from tripl.core.bucketing import floor_to_bucket
from tripl.models.domain_enums import MetricAggregation
from tripl.tests.conformance.conftest import (
    _PG_DB,
    _PG_HOST,
    _PG_PASSWORD,
    _PG_PORT,
    _PG_USER,
    TABLE,
)
from tripl.tests.conformance.dataset import (
    FROM_TIME,
    IN_WINDOW_IDS,
    INTERVALS,
    SHIFTED_WINDOW_IDS,
    TO_TIME,
    contract_expectations,
    expected_bucket_counts,
    expected_bucket_sums,
    expected_contract_violations,
    expected_json_leaf_paths,
    in_window_rows,
)

BASE = f"SELECT * FROM {TABLE}"


def _utc(value: object) -> datetime:
    """Normalize a warehouse-returned bucket to an aware UTC datetime.

    A naive value is assumed to be UTC, exactly as ``bucketing.to_utc`` does — the
    adapter pins the session to UTC, so a naive column's wall clock IS UTC.
    """
    assert isinstance(value, datetime)
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _bucket_counts(
    adapter: PostgresAdapter, interval: str, time_column: str = "ts"
) -> dict[datetime, int]:
    adapter.get_columns(BASE)
    _, _, rows = adapter.get_time_bucketed_counts(
        BASE, time_column, interval, [], [], None, FROM_TIME, TO_TIME
    )
    return {_utc(row[0]): int(row[-1]) for row in rows}  # type: ignore[arg-type]


def _window_ids(adapter: PostgresAdapter, time_column: str = "ts") -> set[int]:
    """Row MEMBERSHIP in the window — not just how many rows there are."""
    adapter.get_columns(BASE)
    _, _, _, rows = adapter.get_full_breakdown(
        BASE,
        ["id"],
        [],
        None,
        time_column=time_column,
        time_from=FROM_TIME,
        time_to=TO_TIME,
    )
    return {int(row[0]) for row in rows}  # type: ignore[arg-type]


# --- the bucket contract ------------------------------------------------------


@pytest.mark.parametrize("interval", INTERVALS)
def test_buckets_match_floor_to_bucket(pg: PostgresAdapter, interval: str) -> None:
    assert _bucket_counts(pg, interval) == expected_bucket_counts(interval)


def test_week_buckets_land_on_monday(pg: PostgresAdapter) -> None:
    # date_bin handed the epoch as its origin would start weeks on a THURSDAY
    # (1970-01-01 was one). The adapter passes WEEK_ORIGIN instead; prove it.
    buckets = _bucket_counts(pg, "1w")
    assert buckets, "the 1w scan returned no buckets at all"
    assert all(bucket.weekday() == 0 for bucket in buckets), sorted(buckets)


def test_window_is_half_open(pg: PostgresAdapter) -> None:
    # id 1 sits exactly on time_from (IN); id 8 exactly on time_to (OUT);
    # id 9 one microsecond before time_from (OUT).
    ids = _window_ids(pg)
    assert ids == set(IN_WINDOW_IDS)
    assert 1 in ids
    assert 8 not in ids
    assert 9 not in ids


# --- the non-UTC server regression -------------------------------------------


def test_non_utc_role_does_not_move_rows_or_buckets(
    pg: PostgresAdapter,
    pg_hostile_tz: Callable[[], PostgresAdapter],
) -> None:
    """The role and database default to Asia/Kolkata; nothing may move.

    Membership, not count: a +05:30 window slide returns SEVEN rows just like the
    correct window does — a different seven. See ``dataset`` for why.

    Both time columns are re-asserted. ``ts`` (timestamptz) is protected by the
    explicit ``+00:00`` on every literal; ``ts_naive`` (a zone-less timestamp,
    promoted to timestamptz in the SESSION timezone for both the comparison and
    ``date_bin``) is protected only by the adapter's ``-c timezone=UTC`` pin. One
    column tests each half of the fix.
    """
    adapter = pg_hostile_tz()
    try:
        for time_column in ("ts", "ts_naive"):
            assert _window_ids(adapter, time_column) == set(IN_WINDOW_IDS), time_column
            for interval in INTERVALS:
                assert _bucket_counts(adapter, interval, time_column) == expected_bucket_counts(
                    interval
                ), (time_column, interval)
    finally:
        adapter.close()


def test_the_hostile_timezone_fixture_actually_has_teeth(
    pg: PostgresAdapter,
    pg_hostile_tz: Callable[[], PostgresAdapter],
) -> None:
    """Prove the trap is live, so the test above cannot pass for the wrong reason.

    This runs the *pre-fix* SQL — an offset-less window literal on a connection with
    no UTC session pin — against the same Kolkata-defaulted server, and shows it
    selects a DIFFERENT SET of rows of the SAME SIZE. If Postgres ever stopped
    reading an offset-less literal in the session timezone, this test would fail and
    tell us the gate above had gone toothless.
    """
    del pg_hostile_tz  # the fixture's side effect (role/db timezone) is what we want
    conn = psycopg.connect(
        host=_PG_HOST,
        port=_PG_PORT,
        dbname=_PG_DB,
        user=_PG_USER,
        password=_PG_PASSWORD,
        autocommit=True,
    )
    try:
        with conn.cursor() as cur:
            cur.execute("SHOW timezone")
            row = cur.fetchone()
            assert row is not None and row[0] != "UTC", "the hostile role timezone did not stick"
            cur.execute(
                f"SELECT id FROM {TABLE} "
                "WHERE ts >= TIMESTAMPTZ '2026-04-02 00:00:00' "
                "AND ts < TIMESTAMPTZ '2026-04-09 00:00:00'"
            )
            shifted = {int(r[0]) for r in cur.fetchall()}
    finally:
        conn.close()

    assert shifted == set(SHIFTED_WINDOW_IDS)
    assert shifted != set(IN_WINDOW_IDS)
    assert len(shifted) == len(IN_WINDOW_IDS), "the count alone would not have caught this"


# --- aggregates, breakdowns, multi-aggregates ---------------------------------


def test_bucketed_aggregate_sums_match_the_contract(pg: PostgresAdapter) -> None:
    pg.get_columns(BASE)
    _, _, rows = pg.get_time_bucketed_aggregate(
        BASE,
        "ts",
        "1d",
        MetricAggregation.sum,
        "amount",
        [],
        [],
        None,
        FROM_TIME,
        TO_TIME,
    )
    actual = {_utc(row[0]): (None if row[-1] is None else float(row[-1])) for row in rows}  # type: ignore[arg-type]
    assert actual == expected_bucket_sums("1d")


def test_bucketed_breakdown_counts_group_in_the_database(pg: PostgresAdapter) -> None:
    pg.get_columns(BASE)
    _, _, rows = pg.get_time_bucketed_breakdown_counts(
        BASE, "ts", "1d", "event_name", ["event_name"], [], None, FROM_TIME, TO_TIME
    )
    actual: dict[tuple[datetime, str], int] = {
        (_utc(row[0]), str(row[1])): int(row[-1])  # type: ignore[arg-type]
        for row in rows
    }
    expected: dict[tuple[datetime, str], int] = {}
    for fixture_row in in_window_rows():
        key = (floor_to_bucket(fixture_row.ts, "1d"), fixture_row.event_name)
        expected[key] = expected.get(key, 0) + 1
    assert actual == expected


def test_multi_aggregate_runs_one_scan_and_agrees_with_the_single_path(
    pg: PostgresAdapter,
) -> None:
    pg.get_columns(BASE)
    names, rows = pg.get_time_bucketed_multi_aggregate(
        BASE,
        "ts",
        "1d",
        [
            AggregateSpec(key="k_cnt", aggregation=MetricAggregation.count),
            AggregateSpec(key="k_sum", aggregation=MetricAggregation.sum, column="amount"),
            AggregateSpec(
                key="k_dist", aggregation=MetricAggregation.count_distinct, column="user_id"
            ),
        ],
        FROM_TIME,
        TO_TIME,
    )
    assert names == ["bucket", "k_cnt", "k_sum", "k_dist"]
    counts = {_utc(row[0]): int(row[1]) for row in rows}  # type: ignore[arg-type]
    sums = {_utc(row[0]): (None if row[2] is None else float(row[2])) for row in rows}  # type: ignore[arg-type]
    assert counts == expected_bucket_counts("1d")
    assert sums == expected_bucket_sums("1d")


# --- nested jsonb -------------------------------------------------------------


def test_nested_jsonb_leaves_are_discovered_as_dotted_paths(pg: PostgresAdapter) -> None:
    pg.get_columns(BASE)
    samples = pg.get_json_path_samples(
        BASE,
        ["doc"],
        time_column="ts",
        time_from=FROM_TIME,
        time_to=TO_TIME,
        # Enough headroom to see every distinct city; the default caps at 3.
        sample_limit=10,
    )
    paths = set(samples["doc"])
    # Full nested leaf paths, not the top-level keys jsonb_object_keys returns.
    assert "user.address.city" in paths
    assert paths == set(expected_json_leaf_paths())
    # An empty object holds no leaf, so it is not a path.
    assert "empty" not in paths
    # Discovery honors the window: the out-of-window rows' cities never surface.
    cities = {str(v) for v in samples["doc"]["user.address.city"]}
    assert cities == {'"Berlin"', '"Paris"', '"Tokyo"', '"Lisbon"', '"Oslo"'}


def test_jsonb_paths_group_as_a_value_in_a_bucketed_scan(pg: PostgresAdapter) -> None:
    pg.get_columns(BASE)
    col_names, json_value_names, rows = pg.get_time_bucketed_counts(
        BASE,
        "ts",
        "1d",
        ["event_name"],
        ["doc"],
        {"doc": ["user.address.city"]},
        FROM_TIME,
        TO_TIME,
    )
    assert col_names == ["event_name", "doc"]
    assert json_value_names == ["doc.user.address.city"]
    assert sum(int(row[-1]) for row in rows) == len(IN_WINDOW_IDS)  # type: ignore[arg-type]
    # The path array is a groupable value, and a document with no leaves groups as
    # the empty array rather than vanishing or erroring.
    assert any(row[2] == [] for row in rows), rows


# --- field contracts / drift --------------------------------------------------


def test_field_contracts_find_exactly_the_drift_that_is_there(pg: PostgresAdapter) -> None:
    """The same contracts, the same counts, on every warehouse.

    PostgreSQL still runs BaseAdapter's Python row-sampling fallback here, while
    ClickHouse validates natively in SQL (tripl-64n8.5 tracks closing that gap). Two
    unrelated implementations must agree on the answer — including the clean contract,
    which must produce no violation at all.
    """
    pg.get_columns(BASE)
    violations = pg.validate_field_contracts(
        BASE,
        contract_expectations(),
        time_column="ts",
        time_from=FROM_TIME,
        time_to=TO_TIME,
    )
    actual = {(v.field_name, v.drift_type): (v.bad_count, v.total_count) for v in violations}
    assert actual == expected_contract_violations()
    assert ("user_id", "regex_violation") not in actual
