"""Credentialed value conformance against real BigQuery.

The emulator gate proves that generated statements are valid GoogleSQL.  This
module proves what those statements compute.  It uses a table-less typed source,
so no dataset or production data is visible to the CI identity and no external
resource can be left behind.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import NoReturn

import pytest

from tripl.core.adapters.base import AggregateSpec
from tripl.core.adapters.bigquery import BigQueryAdapter
from tripl.core.bucketing import floor_to_bucket
from tripl.models.domain_enums import MetricAggregation
from tripl.tests.conformance.bigquery_values import BASE
from tripl.tests.conformance.dataset import (
    FROM_TIME,
    IN_WINDOW_IDS,
    INTERVALS,
    TO_TIME,
    contract_expectations,
    expected_bucket_counts,
    expected_bucket_sums,
    expected_contract_violations,
    expected_json_leaf_paths,
    in_window_rows,
)

pytestmark = pytest.mark.bigquery_value

_TIME_INTERVALS = {
    "ts": INTERVALS,
    "dt": INTERVALS,
    "d": ("1d", "1w"),
}


def _unavailable(reason: str) -> NoReturn:
    message = f"real BigQuery value conformance unavailable: {reason}"
    if os.environ.get("TRIPL_BQ_VALUE_REQUIRED") == "1":
        pytest.fail(message)
    pytest.skip(message)


def _credentials() -> tuple[str, str, str | None]:
    project = os.environ.get("TRIPL_CONF_BQ_REAL_PROJECT", "").strip()
    credentials_json = os.environ.get("TRIPL_CONF_BQ_CREDENTIALS_JSON", "").strip()
    credentials_file = os.environ.get("TRIPL_CONF_BQ_CREDENTIALS_FILE", "").strip()
    location = os.environ.get("TRIPL_CONF_BQ_REAL_LOCATION", "").strip() or None
    if not credentials_json and credentials_file:
        try:
            credentials_json = Path(credentials_file).read_text()
        except OSError as exc:
            _unavailable(f"cannot read credentials file: {exc}")
    missing = [
        name
        for name, value in (
            ("TRIPL_CONF_BQ_REAL_PROJECT", project),
            ("BigQuery credentials JSON or file", credentials_json),
        )
        if not value
    ]
    if missing:
        _unavailable(f"missing {', '.join(missing)}")
    try:
        info = json.loads(credentials_json)
    except json.JSONDecodeError as exc:
        _unavailable(f"credentials JSON is invalid: {exc}")
    if not isinstance(info, dict) or info.get("type") != "service_account":
        _unavailable("credentials are not a service-account JSON object")
    return project, credentials_json, location


@pytest.fixture(scope="session")
def bq_real() -> Iterator[BigQueryAdapter]:
    project, credentials_json, location = _credentials()
    adapter: BigQueryAdapter | None = None
    try:
        try:
            adapter = BigQueryAdapter(
                host=project,
                port=0,
                database="",
                password=credentials_json,
                location=location,
                timeout_seconds=30,
                maximum_bytes_billed=10 * 1024 * 1024,
            )
            adapter.test_connection()
            adapter.get_columns(BASE)
        except Exception as exc:  # noqa: BLE001 - any cloud/auth failure is unavailable
            _unavailable(str(exc))
        yield adapter
    finally:
        if adapter is not None:
            adapter.close()


def _utc_bucket(value: object) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC)
    raise AssertionError(f"unexpected BigQuery bucket type: {type(value).__name__}")


def _bucket_counts(
    adapter: BigQueryAdapter, time_column: str, interval: str
) -> dict[datetime, int]:
    _, _, rows = adapter.get_time_bucketed_counts(
        BASE, time_column, interval, [], [], None, FROM_TIME, TO_TIME
    )
    return {_utc_bucket(row[0]): int(row[-1]) for row in rows}


@pytest.mark.parametrize(
    ("time_column", "interval"),
    [
        (time_column, interval)
        for time_column, intervals in _TIME_INTERVALS.items()
        for interval in intervals
    ],
)
def test_bucket_values_and_counts_match_the_reference(
    bq_real: BigQueryAdapter, time_column: str, interval: str
) -> None:
    actual = _bucket_counts(bq_real, time_column, interval)
    assert actual == expected_bucket_counts(interval)
    if interval == "1w":
        assert actual and all(bucket.weekday() == 0 for bucket in actual)


@pytest.mark.parametrize("time_column", _TIME_INTERVALS)
def test_windows_are_half_open_for_every_time_type(
    bq_real: BigQueryAdapter, time_column: str
) -> None:
    _, _, _, rows = bq_real.get_full_breakdown(
        BASE,
        ["id"],
        [],
        None,
        time_column=time_column,
        time_from=FROM_TIME,
        time_to=TO_TIME,
    )
    ids = {int(row[0]) for row in rows}
    assert ids == set(IN_WINDOW_IDS)
    assert 1 in ids
    assert 8 not in ids
    assert 9 not in ids


@pytest.mark.parametrize("time_column", _TIME_INTERVALS)
def test_bucketed_sums_match_the_reference(bq_real: BigQueryAdapter, time_column: str) -> None:
    _, _, rows = bq_real.get_time_bucketed_aggregate(
        BASE,
        time_column,
        "1d",
        MetricAggregation.sum,
        "amount",
        [],
        [],
        None,
        FROM_TIME,
        TO_TIME,
    )
    actual = {_utc_bucket(row[0]): None if row[-1] is None else float(row[-1]) for row in rows}
    assert actual == expected_bucket_sums("1d")


def test_breakdowns_and_multi_aggregates_match_the_reference(
    bq_real: BigQueryAdapter,
) -> None:
    _, _, rows = bq_real.get_time_bucketed_breakdown_counts(
        BASE, "ts", "1d", "event_name", ["event_name"], [], None, FROM_TIME, TO_TIME
    )
    actual_breakdowns = {(_utc_bucket(row[0]), str(row[1])): int(row[-1]) for row in rows}
    expected_breakdowns: dict[tuple[datetime, str], int] = {}
    for fixture_row in in_window_rows():
        key = (floor_to_bucket(fixture_row.ts, "1d"), fixture_row.event_name)
        expected_breakdowns[key] = expected_breakdowns.get(key, 0) + 1
    assert actual_breakdowns == expected_breakdowns

    names, aggregate_rows = bq_real.get_time_bucketed_multi_aggregate(
        BASE,
        "ts",
        "1d",
        [
            AggregateSpec(key="count", aggregation=MetricAggregation.count),
            AggregateSpec(key="sum", aggregation=MetricAggregation.sum, column="amount"),
            AggregateSpec(
                key="users", aggregation=MetricAggregation.count_distinct, column="user_id"
            ),
        ],
        FROM_TIME,
        TO_TIME,
    )
    assert names == ["bucket", "count", "sum", "users"]
    assert {_utc_bucket(row[0]): int(row[1]) for row in aggregate_rows} == (
        expected_bucket_counts("1d")
    )
    assert {
        _utc_bucket(row[0]): None if row[2] is None else float(row[2]) for row in aggregate_rows
    } == expected_bucket_sums("1d")
    expected_users: dict[datetime, set[str]] = {}
    for fixture_row in in_window_rows():
        bucket = floor_to_bucket(fixture_row.ts, "1d")
        expected_users.setdefault(bucket, set()).add(fixture_row.user_id)
    assert {_utc_bucket(row[0]): int(row[3]) for row in aggregate_rows} == {
        bucket: len(users) for bucket, users in expected_users.items()
    }


def test_json_and_struct_values_execute_on_real_bigquery(bq_real: BigQueryAdapter) -> None:
    samples = bq_real.get_json_path_samples(
        BASE,
        ["doc"],
        time_column="ts",
        time_from=FROM_TIME,
        time_to=TO_TIME,
        sample_limit=10,
    )
    assert set(samples["doc"]) == set(expected_json_leaf_paths())
    cities = {str(value).strip('"') for value in samples["doc"]["user.address.city"]}
    assert cities == {"Berlin", "Paris", "Tokyo", "Lisbon", "Oslo"}

    regular, complex_columns, value_names, rows = bq_real.get_full_breakdown(
        BASE,
        ["event_name"],
        ["doc", "props"],
        {"doc": ["user.address.city"], "props": ["address.city"]},
        time_column="ts",
        time_from=FROM_TIME,
        time_to=TO_TIME,
    )
    assert regular == ["event_name"]
    assert complex_columns == ["doc", "props"]
    assert value_names == ["doc.user.address.city", "props.address.city"]
    assert sum(int(row[-1]) for row in rows) == len(IN_WINDOW_IDS)
    assert all((row[1] is None or isinstance(row[1], list)) for row in rows)
    assert all(isinstance(row[2], list) for row in rows)
    assert any(row[1] is None for row in rows)  # the empty JSON object has no leaf paths
    assert all(row[3] == row[4] for row in rows)
    assert {row[3] for row in rows} == {
        "null",
        '"Berlin"',
        '"Paris"',
        '"Tokyo"',
        '"Lisbon"',
        '"Oslo"',
    }

    columns, multi_value_names, multi_rows = bq_real.get_time_bucketed_breakdown_counts_multi(
        BASE,
        "ts",
        "1d",
        ["event_name"],
        ["event_name"],
        ["doc", "props"],
        {"doc": ["user.address.city"], "props": ["address.city"]},
        FROM_TIME,
        TO_TIME,
    )
    assert columns == ["event_name", "doc", "props"]
    assert multi_value_names == ["doc.user.address.city", "props.address.city"]
    assert sum(int(row[-1]) for row in multi_rows) == len(IN_WINDOW_IDS)
    assert all(row[1] == "event_name" and row[2] == row[4] for row in multi_rows)
    assert all(row[7] == row[8] for row in multi_rows)


@pytest.mark.parametrize("time_column", _TIME_INTERVALS)
def test_field_contract_counts_match_the_reference(
    bq_real: BigQueryAdapter, time_column: str
) -> None:
    violations = bq_real.validate_field_contracts(
        BASE,
        contract_expectations(),
        time_column=time_column,
        time_from=FROM_TIME,
        time_to=TO_TIME,
    )
    actual: dict[tuple[str, str], tuple[int, int]] = {
        (violation.field_name, violation.drift_type): (
            violation.bad_count,
            violation.total_count,
        )
        for violation in violations
    }
    assert actual == expected_contract_violations()
    assert ("user_id", "regex_violation") not in actual
