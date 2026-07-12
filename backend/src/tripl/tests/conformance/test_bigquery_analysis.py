"""Gate 3: every statement BigQueryAdapter generates must ANALYZE as valid GoogleSQL.

Why this file exists
--------------------
BigQuery is the one warehouse we cannot execute against in CI — it needs GCP
credentials, and there are none. So BigQuery got fake-client tests that asserted
generated SQL *strings*, and a fake client accepts any string. That is how
``TIMESTAMP_BIN`` — a function GoogleSQL does not have — shipped in every bucket
query with a green suite, and how a ``GROUP BY <ARRAY>`` — which GoogleSQL rejects
outright — sat in every BigQuery JSON scan.

``ghcr.io/goccy/bigquery-emulator`` closes that hole with no credentials at all: it
embeds Google's **real ZetaSQL analyzer**, so it is AUTHORITATIVE on whether a
statement is valid GoogleSQL. The gate drives the real ``BigQueryAdapter`` with a
client that CAPTURES the SQL it generates, then posts each captured statement to the
emulator and asserts the analyzer accepts it.

Verified emulator verdicts (these are the analyzer's own words):

* ``TIMESTAMP_BIN(...)``      -> "Function not found: TIMESTAMP_BIN"                (old P0)
* ``GROUP BY ['a','b']``      -> "Grouping by expressions of type ARRAY is not allowed"
* ``GROUP BY <array literal>``-> "Cannot GROUP BY literal values"
* ``TIMESTAMP_BUCKET`` / ``DATETIME_BUCKET`` / ``DATE_BUCKET``,
  ``*_TRUNC(..., WEEK(MONDAY))``, ``JSON_KEYS(doc, 20)``, ``GROUPING SETS``  -> all valid

!!! CRITICAL — DO NOT "STRENGTHEN" THIS GATE INTO VALUE ASSERTIONS !!!
----------------------------------------------------------------------
The emulator is authoritative for **ANALYSIS ONLY**. Its *computed values* are NOT
BigQuery's. Demonstrated: ``DATETIME_TRUNC(DATETIME '2026-04-08 13:00:00',
WEEK(MONDAY))`` returns ``2026-04-06T13:00:00`` on the emulator — it wrongly keeps
the time component, where real BigQuery returns ``2026-04-06T00:00:00``.

So this gate asserts exactly one thing: **every generated statement analyzes
successfully.** It must never assert a bucket value, a count, or any other computed
result against the emulator. Doing so would produce either a false failure (correct
SQL, emulator's wrong value) or — far worse — a false PASS that certifies a bucket
contract the emulator got wrong. Bucket *values* are proven on PostgreSQL and
ClickHouse, which are executed for real; see the sibling modules.

Getting true value-level BigQuery conformance (NOT wired — no credentials exist)
--------------------------------------------------------------------------------
A maintainer with a GCP project can add it. It is deliberately left unwired because
the project has no credentials to offer and a half-configured secret gate is worse
than an honest gap. What it would take:

1. A service account with ``roles/bigquery.jobUser`` on a project, and
   ``roles/bigquery.dataEditor`` on ONE dedicated, throwaway dataset (e.g.
   ``tripl_conformance``). Nothing else — no access to production data.
2. Repository secrets: ``BQ_SERVICE_ACCOUNT_JSON`` (the key file's contents),
   ``BQ_PROJECT``, ``BQ_DATASET``.
3. A separate CI job, gated on ``secrets.BQ_SERVICE_ACCOUNT_JSON != ''`` so forked
   PRs (which never receive secrets) skip it rather than fail. It must NOT be a
   required check on forks.
4. The job seeds ``dataset.ROWS`` into a ``TIMESTAMP``/``DATETIME``/``DATE`` table
   with a ``JSON`` and a ``STRUCT`` column, constructs a real ``BigQueryAdapter``
   (host=project, password=the key JSON, database=dataset) and re-runs the SAME
   assertions the PostgreSQL gate makes — ``expected_bucket_counts``,
   ``expected_bucket_sums``, Monday-anchored weeks, half-open membership — because
   ``dataset.py`` is deliberately warehouse-agnostic.
5. Bound the cost: the fixture is nine rows, so every query is a full scan of a few
   KB. Set ``maximum_bytes_billed`` on the job config anyway, and tear the table
   down in an ``always()`` step.

Until that exists, BigQuery bucket VALUES remain unproven by CI. That is a known,
stated gap — not something this file quietly pretends to cover.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator

import pytest
from google.cloud import bigquery

from tripl.core.adapters.base import AggregateSpec
from tripl.core.adapters.bigquery import BigQueryAdapter
from tripl.models.domain_enums import MetricAggregation
from tripl.tests.conformance.dataset import FROM_TIME, INTERVALS, TO_TIME

# A table-less source. GoogleSQL can SELECT from an UNNEST of a STRUCT literal, so
# the gate needs no table, no dataset seeding and no credentials — while still giving
# the analyzer a fully typed relation to resolve every generated column against.
BASE = (
    "SELECT * FROM UNNEST([STRUCT("
    "TIMESTAMP '2026-04-02 00:00:00+00' AS ts, "
    "DATETIME '2026-04-02 00:00:00' AS dt, "
    "DATE '2026-04-02' AS d, "
    "'click' AS event_name, "
    "1.5 AS amount, "
    "'u1' AS user_id, "
    'JSON \'{"user":{"address":{"city":"Berlin"}},"tags":["a"]}\' AS doc, '
    "STRUCT(STRUCT('Berlin' AS city) AS address, 7 AS id, ['a','b'] AS tags) AS props, "
    "[STRUCT('x' AS k)] AS items"
    ")])"
)

# The schema the source above declares, exactly as BigQuery would report it. The gate
# feeds this to the adapter's OWN `get_columns`, rather than reaching in and setting
# its private state: the adapter then derives its allowed columns, declared types,
# STRUCT leaf paths and repeated-column set itself, so this gate keeps working when
# that internal state changes shape — and `get_columns` gets exercised for free.
#
# `props.tags` is a REPEATED *leaf* (ARRAY<STRING>), which dotted access CAN reach.
# `items` is a REPEATED STRUCT, whose leaves dotted access CANNOT reach (GoogleSQL
# needs UNNEST) — the adapter must refuse those rather than emit broken SQL.
_SCHEMA: list[bigquery.SchemaField] = [
    bigquery.SchemaField("ts", "TIMESTAMP"),
    bigquery.SchemaField("dt", "DATETIME"),
    bigquery.SchemaField("d", "DATE"),
    bigquery.SchemaField("event_name", "STRING"),
    bigquery.SchemaField("amount", "FLOAT64"),
    bigquery.SchemaField("user_id", "STRING"),
    bigquery.SchemaField("doc", "JSON"),
    bigquery.SchemaField(
        "props",
        "RECORD",
        fields=(
            bigquery.SchemaField(
                "address", "RECORD", fields=(bigquery.SchemaField("city", "STRING"),)
            ),
            bigquery.SchemaField("id", "INTEGER"),
            bigquery.SchemaField("tags", "STRING", mode="REPEATED"),
        ),
    ),
    bigquery.SchemaField(
        "items",
        "RECORD",
        mode="REPEATED",
        fields=(bigquery.SchemaField("k", "STRING"),),
    ),
]

#: A DATE column has no time-of-day, so the adapter refuses sub-day intervals on it.
_INTERVALS_BY_TIME_COLUMN = {
    "ts": INTERVALS,
    "dt": INTERVALS,
    "d": ("1d", "1w"),
}

_TIME_COLUMNS = tuple(_INTERVALS_BY_TIME_COLUMN)


class _CapturingClient:
    """Records every statement the adapter generates; returns nothing useful.

    Two queries need a canned response. The ``LIMIT 0`` schema probe gets ``_SCHEMA``,
    so the adapter can introspect itself. The top-values probe is the one query whose
    *result* feeds the next statement (it becomes the ``IN (...)`` list that drives
    Other-folding), so it gets seeded values. Everything else returns no rows: this
    gate asserts that SQL is VALID, never what it computes.
    """

    def __init__(self) -> None:
        self.sql: list[str] = []

    def query(self, sql: str) -> _Job:
        self.sql.append(sql)
        if sql.endswith("LIMIT 0"):  # the schema probe
            return _Job([], schema=_SCHEMA)
        if "__bd_raw_" in sql:  # the top-values probe
            return _Job([("event_name", "click"), ("event_name", "view")])
        return _Job([])

    def close(self) -> None:
        return None


class _Job:
    def __init__(
        self, rows: list[tuple[object, ...]], schema: list[bigquery.SchemaField] | None = None
    ) -> None:
        self._rows = rows
        self._schema = schema or []

    def result(self, **_kwargs: object) -> _Result:
        return _Result(self._rows, self._schema)


class _Result:
    def __init__(self, rows: list[tuple[object, ...]], schema: list[bigquery.SchemaField]) -> None:
        self._rows = rows
        self.schema = schema

    def __iter__(self) -> Iterator[_Row]:
        return iter(_Row(row) for row in self._rows)


class _Row:
    def __init__(self, values: tuple[object, ...]) -> None:
        self._values = values

    def values(self) -> tuple[object, ...]:
        return self._values


def _new_adapter() -> tuple[BigQueryAdapter, _CapturingClient]:
    """The REAL BigQueryAdapter, wired to a client that only captures SQL.

    ``__init__`` is bypassed because it would build a live ``bigquery.Client`` from
    service-account credentials, which is exactly what this gate exists to avoid
    needing. Everything else is the real adapter.
    """
    client = _CapturingClient()
    adapter = object.__new__(BigQueryAdapter)
    adapter._client = client  # type: ignore[assignment]
    adapter._project = "tripl-test"
    adapter._dataset = "wh"
    return adapter, client


@pytest.fixture
def bq() -> tuple[BigQueryAdapter, _CapturingClient]:
    """A capturing adapter that has already introspected its own schema.

    ``get_columns`` is what populates the adapter's declared types, STRUCT leaf paths
    and repeated-column set — the state that decides which bucket function, which
    window literal and which nested-path expansion the SQL gets. Letting the adapter
    derive all of that itself (rather than hand-seeding its private attributes) keeps
    this gate honest when that internal state is refactored.

    The probe's own SQL is dropped from the capture afterwards so each test asserts on
    the statement it actually drove; ``test_schema_probe_analyzes`` covers the probe.
    """
    adapter, client = _new_adapter()
    adapter.get_columns(BASE)
    client.sql.clear()
    return adapter, client


def test_schema_probe_analyzes(bq_analyze: Callable[[str], str | None]) -> None:
    adapter, client = _new_adapter()
    adapter.get_columns(BASE)
    _assert_analyzes(bq_analyze, client, "get_columns schema probe")


def _assert_analyzes(
    bq_analyze: Callable[[str], str | None],
    client: _CapturingClient,
    label: str,
) -> None:
    """Every captured statement must be accepted by ZetaSQL. Nothing else is checked."""
    assert client.sql, f"{label}: the adapter generated no SQL at all"
    rejected = [(sql, error) for sql in client.sql if (error := bq_analyze(sql)) is not None]
    if rejected:
        detail = "\n\n".join(f"  REJECTED: {error}\n  SQL: {sql}" for sql, error in rejected)
        pytest.fail(
            f"{label}: ZetaSQL rejected {len(rejected)} of {len(client.sql)} "
            f"generated statement(s):\n{detail}"
        )


# --- scalar scans, across all three time-type families ------------------------


@pytest.mark.parametrize("time_column", _TIME_COLUMNS)
def test_preview_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    time_column: str,
) -> None:
    adapter, client = bq
    adapter.get_preview_rows(
        BASE, 10, time_column=time_column, time_from=FROM_TIME, time_to=TO_TIME
    )
    _assert_analyzes(bq_analyze, client, f"preview[{time_column}]")


def test_full_breakdown_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
) -> None:
    adapter, client = bq
    adapter.get_full_breakdown(
        BASE,
        ["event_name", "user_id"],
        [],
        None,
        time_column="ts",
        time_from=FROM_TIME,
        time_to=TO_TIME,
    )
    _assert_analyzes(bq_analyze, client, "full_breakdown")


@pytest.mark.parametrize(
    ("time_column", "interval"),
    [
        (column, interval)
        for column, cadence in _INTERVALS_BY_TIME_COLUMN.items()
        for interval in cadence
    ],
)
def test_bucketed_counts_analyze(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    time_column: str,
    interval: str,
) -> None:
    # This is the parametrization that would have caught TIMESTAMP_BIN on day one.
    adapter, client = bq
    adapter.get_time_bucketed_counts(
        BASE, time_column, interval, ["event_name"], [], None, FROM_TIME, TO_TIME
    )
    _assert_analyzes(bq_analyze, client, f"bucketed_counts[{time_column}/{interval}]")


@pytest.mark.parametrize(
    ("aggregation", "measure"),
    [
        (MetricAggregation.count, None),
        (MetricAggregation.sum, "amount"),
        (MetricAggregation.avg, "amount"),
        (MetricAggregation.min, "amount"),
        (MetricAggregation.max, "amount"),
        (MetricAggregation.count_distinct, "user_id"),
    ],
)
def test_bucketed_aggregate_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    aggregation: MetricAggregation,
    measure: str | None,
) -> None:
    adapter, client = bq
    adapter.get_time_bucketed_aggregate(
        BASE, "ts", "1h", aggregation, measure, [], [], None, FROM_TIME, TO_TIME
    )
    _assert_analyzes(bq_analyze, client, f"bucketed_aggregate[{aggregation.value}]")


@pytest.mark.parametrize("values_limit", [None, 3])
def test_aggregate_breakdown_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    values_limit: int | None,
) -> None:
    # values_limit drives the top-values probe AND the Other-folding CASE/IN form, so
    # both statements land in the capture and both are analyzed.
    adapter, client = bq
    adapter.get_time_bucketed_aggregate_breakdown(
        BASE,
        "ts",
        "1d",
        MetricAggregation.sum,
        "amount",
        "event_name",
        ["event_name"],
        [],
        None,
        FROM_TIME,
        TO_TIME,
        values_limit=values_limit,
    )
    _assert_analyzes(bq_analyze, client, f"aggregate_breakdown[values_limit={values_limit}]")


@pytest.mark.parametrize("time_column", _TIME_COLUMNS)
def test_multi_aggregate_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    time_column: str,
) -> None:
    adapter, client = bq
    adapter.get_time_bucketed_multi_aggregate(
        BASE,
        time_column,
        "1d",
        [
            AggregateSpec(key="k_cnt", aggregation=MetricAggregation.count),
            AggregateSpec(key="k_sum", aggregation=MetricAggregation.sum, column="amount"),
            AggregateSpec(
                key="k_dist", aggregation=MetricAggregation.count_distinct, column="user_id"
            ),
            # Conditional aggregates: BigQuery has no FILTER (WHERE ...), so these
            # fold into CASE / IF forms. Their validity is exactly what is at stake.
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
        ],
        FROM_TIME,
        TO_TIME,
    )
    _assert_analyzes(bq_analyze, client, f"multi_aggregate[{time_column}]")


@pytest.mark.parametrize("values_limit", [None, 3])
def test_multi_aggregate_breakdown_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    values_limit: int | None,
) -> None:
    adapter, client = bq
    adapter.get_time_bucketed_multi_aggregate_breakdown(
        BASE,
        "ts",
        "1d",
        "event_name",
        [
            AggregateSpec(key="k_cnt", aggregation=MetricAggregation.count),
            AggregateSpec(key="k_max", aggregation=MetricAggregation.max, column="amount"),
        ],
        FROM_TIME,
        TO_TIME,
        values_limit=values_limit,
    )
    _assert_analyzes(bq_analyze, client, f"multi_aggregate_breakdown[values_limit={values_limit}]")


@pytest.mark.parametrize("values_limit", [None, 3])
def test_grouping_sets_multi_breakdown_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    values_limit: int | None,
) -> None:
    # GROUPING SETS + GROUPING() + the top-values ROW_NUMBER probe, in one go.
    adapter, client = bq
    adapter.get_time_bucketed_breakdown_counts_multi(
        BASE,
        "ts",
        "1h",
        ["event_name", "user_id"],
        ["event_name", "user_id"],
        [],
        None,
        FROM_TIME,
        TO_TIME,
        values_limit=values_limit,
    )
    _assert_analyzes(bq_analyze, client, f"grouping_sets[values_limit={values_limit}]")


def test_top_values_probe_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
) -> None:
    adapter, client = bq
    adapter._top_breakdown_values_multi(
        BASE, "ts", ["event_name", "user_id"], FROM_TIME, TO_TIME, 5
    )
    _assert_analyzes(bq_analyze, client, "top_values_probe")


# --- nested columns: JSON, STRUCT, REPEATED -----------------------------------


@pytest.mark.parametrize("nested_column", ["doc", "props"])
def test_nested_column_scans_analyze(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    nested_column: str,
) -> None:
    """JSON and STRUCT path enumeration inside a bucketed scan.

    This is where the current P0 lives. The adapter emits the column's leaf-path set
    as an ARRAY — ``JSON_KEYS`` for a JSON column, an array literal for a STRUCT —
    and then GROUPs BY it. GoogleSQL forbids both ("Grouping by expressions of type
    ARRAY is not allowed" / "Cannot GROUP BY literal values"), which is precisely
    what a fake-client string assertion could never see.
    """
    paths = {"doc": ["user.address.city"], "props": ["address.city"]}[nested_column]
    adapter, client = bq
    adapter.get_time_bucketed_counts(
        BASE,
        "ts",
        "1d",
        ["event_name"],
        [nested_column],
        {nested_column: paths},
        FROM_TIME,
        TO_TIME,
    )
    _assert_analyzes(bq_analyze, client, f"bucketed_counts[nested={nested_column}]")


@pytest.mark.parametrize("nested_column", ["doc", "props"])
def test_nested_full_breakdown_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
    nested_column: str,
) -> None:
    paths = {"doc": ["user.address.city"], "props": ["address.city"]}[nested_column]
    adapter, client = bq
    adapter.get_full_breakdown(
        BASE,
        ["event_name"],
        [nested_column],
        {nested_column: paths},
        time_column="ts",
        time_from=FROM_TIME,
        time_to=TO_TIME,
    )
    _assert_analyzes(bq_analyze, client, f"full_breakdown[nested={nested_column}]")


def test_repeated_leaf_of_a_struct_analyzes(
    bq: tuple[BigQueryAdapter, _CapturingClient],
    bq_analyze: Callable[[str], str | None],
) -> None:
    # `props.tags` is ARRAY<STRING> — a REPEATED leaf. TO_JSON_STRING renders it as
    # the JSON array ClickHouse would return, which makes it a groupable STRING.
    adapter, client = bq
    adapter.get_time_bucketed_aggregate(
        BASE,
        "ts",
        "1d",
        MetricAggregation.count,
        None,
        ["event_name"],
        ["props"],
        {"props": ["tags"]},
        FROM_TIME,
        TO_TIME,
    )
    _assert_analyzes(bq_analyze, client, "bucketed_aggregate[repeated struct leaf]")


def test_path_under_a_repeated_struct_is_refused_before_it_becomes_sql(
    bq: tuple[BigQueryAdapter, _CapturingClient],
) -> None:
    # `items` is ARRAY<STRUCT<k STRING>>; GoogleSQL cannot reach `items.k` with dotted
    # access at all (it needs UNNEST). The adapter must refuse loudly rather than emit
    # SQL that fails opaquely in a worker — so there is nothing here to analyze.
    adapter, client = bq
    with pytest.raises(ValueError, match="repeated"):
        adapter.get_time_bucketed_counts(
            BASE, "ts", "1d", [], ["items"], {"items": ["k"]}, FROM_TIME, TO_TIME
        )
    assert client.sql == []


def test_sub_day_interval_on_a_date_column_is_refused(
    bq: tuple[BigQueryAdapter, _CapturingClient],
) -> None:
    adapter, client = bq
    with pytest.raises(ValueError, match="no time-of-day"):
        adapter.get_time_bucketed_counts(BASE, "d", "15m", [], [], None, FROM_TIME, TO_TIME)
    assert client.sql == []


# --- the analyzer itself is a live oracle -------------------------------------


def test_the_emulator_actually_rejects_the_two_known_p0s(
    bq_analyze: Callable[[str], str | None],
) -> None:
    """Prove the gate has teeth: the analyzer really does reject what we claim it does.

    Without this, a misconfigured emulator that accepted everything would turn the
    whole BigQuery gate into a green no-op.
    """
    timestamp_bin = bq_analyze(
        "SELECT TIMESTAMP_BIN(TIMESTAMP '2026-01-01', INTERVAL 1 HOUR, TIMESTAMP '1970-01-01') AS b"
    )
    assert timestamp_bin is not None and "TIMESTAMP_BIN" in timestamp_bin

    group_by_array = bq_analyze("SELECT COUNT(*) FROM (SELECT ['a','b'] AS p) GROUP BY p")
    assert group_by_array is not None and "ARRAY is not allowed" in group_by_array

    # ...and it accepts the forms the adapter is supposed to be using.
    assert (
        bq_analyze(
            "SELECT TIMESTAMP_BUCKET(TIMESTAMP '2026-01-01', INTERVAL 1 HOUR, "
            "TIMESTAMP '1970-01-01') AS b"
        )
        is None
    )
    assert bq_analyze("SELECT DATETIME_TRUNC(DATETIME '2026-04-08', WEEK(MONDAY)) AS b") is None
    assert bq_analyze('SELECT JSON_KEYS(JSON \'{"a":{"b":1}}\', 20) AS k') is None
