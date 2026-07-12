"""The one canonical fixture dataset every warehouse conformance gate seeds.

One dataset, three warehouses: the same rows are loaded into PostgreSQL and
ClickHouse and rendered as a table-less GoogleSQL literal for BigQuery, so a
divergence between two adapters is a real divergence and not a fixture artifact.

The timestamps are not arbitrary. They are chosen so that a *timezone-shifted*
window returns the SAME NUMBER OF ROWS as the correct one, but a DIFFERENT SET of
rows — the exact shape of the bug this suite exists to catch. A gate that only
compared counts would have passed against the broken code.

Concretely, the correct window is ``[2026-04-02T00:00Z, 2026-04-09T00:00Z)`` and
selects ids 1-7 (seven rows). Reading the window bounds as ``Asia/Kolkata``
wall-clock (UTC+05:30) — which is what an offset-less SQL literal does on a
non-UTC server — slides it to ``[2026-04-01T18:30Z, 2026-04-08T18:30Z)``, which
drops id 7 and picks up id 9: still seven rows, a different seven. Hence every
timezone assertion here compares row MEMBERSHIP, never row count.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime

from tripl.core.adapters.base import FieldContractExpectation
from tripl.core.bucketing import floor_to_bucket
from tripl.json_paths import flatten_json_paths

#: Half-open scan window: ``time_from <= t < time_to``. A Thursday to a Thursday,
#: so it straddles a Monday week boundary and 1w bucketing is actually exercised.
FROM_TIME = datetime(2026, 4, 2, 0, 0, 0, tzinfo=UTC)
TO_TIME = datetime(2026, 4, 9, 0, 0, 0, tzinfo=UTC)

#: Every interval the product offers. All five are asserted against
#: ``floor_to_bucket`` on every executing warehouse.
INTERVALS = ("15m", "1h", "6h", "1d", "1w")


@dataclass(frozen=True)
class FixtureRow:
    id: int
    ts: datetime
    event_name: str
    amount: float | None
    user_id: str
    doc: dict[str, object]


ROWS: tuple[FixtureRow, ...] = (
    # Exactly ON time_from. Half-open windows include it.
    FixtureRow(
        id=1,
        ts=datetime(2026, 4, 2, 0, 0, 0, 0, tzinfo=UTC),
        event_name="click",
        amount=1.5,
        user_id="u1",
        doc={
            "user": {"id": 7, "address": {"city": "Berlin", "zip": None}},
            "tags": ["a", "b"],
            # An empty object has no leaf, so it is NOT a discoverable path.
            "empty": {},
        },
    ),
    # The last microsecond of the first 15m bucket — shares bucket 1 with id 1.
    FixtureRow(
        id=2,
        ts=datetime(2026, 4, 2, 0, 14, 59, 999999, tzinfo=UTC),
        event_name="click",
        amount=2.5,
        user_id="u1",
        doc={"user": {"id": 8, "address": {"city": "Berlin"}}, "tags": []},
    ),
    # The first microsecond of the second 15m bucket.
    FixtureRow(
        id=3,
        ts=datetime(2026, 4, 2, 0, 15, 0, 0, tzinfo=UTC),
        event_name="view",
        amount=None,
        user_id="u2",
        doc={"user": {"id": 9, "address": {"city": "Paris"}}, "flag": True},
    ),
    # 05:30Z. In Asia/Tokyo this is 14:30 the same day; in Asia/Kolkata it is
    # exactly the +05:30 offset, so a shifted grid lands it on a bucket edge.
    FixtureRow(
        id=4,
        ts=datetime(2026, 4, 2, 5, 30, 0, 0, tzinfo=UTC),
        event_name="view",
        amount=10.0,
        user_id="u3",
        doc={"user": {"id": 10, "address": {"city": "Tokyo"}}, "tags": ["c"]},
    ),
    # Sunday 23:59:59 — the last second of the week that STARTED Mon 2026-03-30.
    FixtureRow(
        id=5,
        ts=datetime(2026, 4, 5, 23, 59, 59, 0, tzinfo=UTC),
        event_name="buy",
        amount=99.0,
        user_id="u2",
        doc={"user": {"id": 11, "address": {"city": "Lisbon"}}},
    ),
    # Monday 00:00:00 — the first instant of the week that STARTS Mon 2026-04-06.
    FixtureRow(
        id=6,
        ts=datetime(2026, 4, 6, 0, 0, 0, 0, tzinfo=UTC),
        event_name="buy",
        amount=5.0,
        user_id="u4",
        doc={},
    ),
    # 18:45Z. A window slid +05:30 pushes its upper bound back to 18:30Z and
    # DROPS this row — while picking up id 9 below, keeping the count at seven.
    FixtureRow(
        id=7,
        ts=datetime(2026, 4, 8, 18, 45, 0, 0, tzinfo=UTC),
        event_name="click",
        amount=7.0,
        user_id="u4",
        doc={"user": {"id": 12, "address": {"city": "Oslo"}}, "note": None},
    ),
    # Exactly ON time_to. Half-open windows EXCLUDE it.
    FixtureRow(
        id=8,
        ts=datetime(2026, 4, 9, 0, 0, 0, 0, tzinfo=UTC),
        event_name="click",
        amount=1.0,
        user_id="u9",
        doc={"user": {"id": 98, "address": {"city": "OutAfter"}}},
    ),
    # One microsecond BEFORE time_from. Excluded — unless the window slides.
    FixtureRow(
        id=9,
        ts=datetime(2026, 4, 1, 23, 59, 59, 999999, tzinfo=UTC),
        event_name="click",
        amount=1.0,
        user_id="u9",
        doc={"user": {"id": 99, "address": {"city": "OutBefore"}}},
    ),
)

#: The rows a correct half-open UTC window selects. Ids, not a count: the whole
#: point of this fixture is that the count alone cannot tell you it is right.
IN_WINDOW_IDS = frozenset(row.id for row in ROWS if FROM_TIME <= row.ts < TO_TIME)

#: What a window whose bounds are mis-read as local wall clock selects instead.
#:
#: Both hostile zones this suite uses land on the same set, which is convenient and
#: not a coincidence — any eastward shift large enough to cross 18:45 but smaller
#: than a day drops id 7 and picks up id 9:
#:
#: * Asia/Kolkata (+05:30) -> [2026-04-01T18:30Z, 2026-04-08T18:30Z)
#: * Asia/Tokyo   (+09:00) -> [2026-04-01T15:00Z, 2026-04-08T15:00Z)
#:
#: Asserted to be the same SIZE as IN_WINDOW_IDS but a different SET, so the fixture
#: is proven to have teeth rather than merely assumed to.
SHIFTED_WINDOW_IDS = frozenset({1, 2, 3, 4, 5, 6, 9})


def in_window_rows() -> tuple[FixtureRow, ...]:
    return tuple(row for row in ROWS if row.id in IN_WINDOW_IDS)


def contract_expectations() -> list[FieldContractExpectation]:
    """``CONTRACTS`` as the adapter-facing dataclass, with a zero threshold."""
    return [
        FieldContractExpectation(field_name=field, drift_type=drift, threshold=0.0, **options)  # type: ignore[arg-type]
        for field, drift, options in CONTRACTS
    ]


def expected_bucket_counts(interval: str) -> dict[datetime, int]:
    """The bucket -> row-count map ``floor_to_bucket`` says the warehouse must return."""
    counts: dict[datetime, int] = {}
    for row in in_window_rows():
        bucket = floor_to_bucket(row.ts, interval)
        counts[bucket] = counts.get(bucket, 0) + 1
    return counts


def expected_bucket_sums(interval: str) -> dict[datetime, float | None]:
    """Per-bucket ``sum(amount)``, with SQL's NULL-skipping semantics."""
    sums: dict[datetime, float | None] = {}
    for row in in_window_rows():
        bucket = floor_to_bucket(row.ts, interval)
        if row.amount is None:
            sums.setdefault(bucket, None)
            continue
        current = sums.get(bucket)
        sums[bucket] = row.amount if current is None else current + row.amount
    return sums


def expected_json_leaf_paths() -> frozenset[str]:
    """The dotted leaf paths the in-window documents hold.

    Computed with ``flatten_json_paths`` — the local reference implementation the
    warehouse-side path walks (PostgreSQL's recursive ``jsonb_each``, ClickHouse's
    ``JSONAllPaths``, BigQuery's ``JSON_KEYS``) all claim parity with. Objects are
    recursed and are not paths themselves, arrays and JSON nulls are leaves, and an
    empty object contributes nothing.
    """
    paths: set[str] = set()
    for row in in_window_rows():
        paths.update(path for path, _ in flatten_json_paths(row.doc))
    return frozenset(paths)


#: Field contracts checked on every executing warehouse.
#:
#: ClickHouse validates these with a native warehouse-side aggregate query; PostgreSQL
#: and BigQuery still fall back to BaseAdapter's Python row sampling (tripl-64n8.5).
#: Two completely different implementations, one required answer — which is precisely
#: what a conformance gate is for. The thresholds are 0.0 so the assertion is about the
#: COUNTS the two paths derive, not about threshold arithmetic.
CONTRACTS: tuple[tuple[str, str, dict[str, object]], ...] = (
    ("event_name", "enum_violation", {"enum_options": ("click", "view")}),
    ("amount", "required_null_violation", {}),
    ("amount", "range_violation", {"min_value": 0.0, "max_value": 50.0}),
    # A contract nothing violates. It must produce NO violation — a validator that
    # reported one here would be inventing drift out of clean data.
    ("user_id", "regex_violation", {"regex": "^u[0-9]+$"}),
)


def expected_contract_violations() -> dict[tuple[str, str], tuple[int, int]]:
    """``(field, drift_type) -> (bad_count, total_count)``, per BaseAdapter's semantics.

    ``required_null_violation`` counts every row (a NULL is the violation). Every other
    drift type SKIPS nulls entirely, so its total is the non-null population. A contract
    with zero bad rows is not reported at all.
    """
    violations: dict[tuple[str, str], tuple[int, int]] = {}
    for field, drift, options in CONTRACTS:
        bad = total = 0
        for row in in_window_rows():
            value = row.amount if field == "amount" else getattr(row, field)
            if drift == "required_null_violation":
                total += 1
                bad += value is None
                continue
            if value is None:
                continue
            total += 1
            if drift == "enum_violation":
                bad += str(value) not in options["enum_options"]  # type: ignore[operator]
            elif drift == "regex_violation":
                bad += re.search(str(options["regex"]), str(value)) is None
            elif drift == "range_violation":
                numeric = float(str(value))
                bad += numeric < float(str(options["min_value"])) or numeric > float(
                    str(options["max_value"])
                )
        if bad:
            violations[(field, drift)] = (bad, total)
    return violations


def json_null_only_leaf_paths() -> frozenset[str]:
    """Leaf paths whose every in-window value is a JSON ``null``.

    These are the paths the three warehouses genuinely DISAGREE about, and the
    conformance gates say so out loud instead of averaging over it.

    PostgreSQL's recursive ``jsonb_each`` walk (and ``flatten_json_paths``, the local
    reference) treat a JSON null as a leaf: the key exists in the document, so it
    stays discoverable. ClickHouse's ``JSON`` type does not materialize a null-valued
    dynamic subcolumn at all, so ``JSONAllPaths`` never reports the path — the key
    is invisible to discovery. Tracked as a real divergence, not hidden: the
    ClickHouse gate asserts these are the ONLY paths it is missing, so any OTHER
    path going missing still fails, and ClickHouse one day reporting them also fails
    (and tells us to tighten this back up).
    """
    values_by_path: dict[str, list[object]] = {}
    for row in in_window_rows():
        for path, value in flatten_json_paths(row.doc):
            values_by_path.setdefault(path, []).append(value)
    return frozenset(
        path for path, values in values_by_path.items() if all(value is None for value in values)
    )
