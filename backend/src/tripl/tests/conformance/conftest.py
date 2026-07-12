"""Warehouse wiring for the conformance gates: connect, seed, and skip honestly.

Two rules govern everything here.

**A developer without Docker must not be blocked.** An unreachable warehouse
SKIPS, it does not error, so ``uv run pytest`` on a laptop stays green.

**CI must not be allowed to skip.** A skip in CI means a container failed to come
up, and a gate that silently no-ops reports green while testing nothing — which is
strictly worse than having no gate at all. Setting ``TRIPL_CONFORMANCE_REQUIRED=1``
(CI does) turns every "warehouse unreachable" skip into a hard FAILURE. The CI job
additionally asserts, from the JUnit XML, that a non-zero number of conformance
tests actually ran and that none of them skipped.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from typing import NoReturn

import pytest

from tripl.core.adapters.clickhouse import ClickHouseAdapter
from tripl.core.adapters.postgres import PostgresAdapter
from tripl.tests.conformance.dataset import ROWS, FixtureRow

# Connection settings. The defaults match the CI service containers. Locally they
# point at a database name (`tripl_conformance`) that the dev stack does not have,
# so a stray `pytest` run connects to nothing and skips rather than seeding tables
# into a developer's working database.
_PG_HOST = os.environ.get("TRIPL_CONF_PG_HOST", "localhost")
_PG_PORT = int(os.environ.get("TRIPL_CONF_PG_PORT", "5432"))
_PG_DB = os.environ.get("TRIPL_CONF_PG_DB", "tripl_conformance")
_PG_USER = os.environ.get("TRIPL_CONF_PG_USER", "tripl")
_PG_PASSWORD = os.environ.get("TRIPL_CONF_PG_PASSWORD", "tripl")

_CH_HOST = os.environ.get("TRIPL_CONF_CH_HOST", "localhost")
_CH_PORT = int(os.environ.get("TRIPL_CONF_CH_PORT", "8123"))
_CH_DB = os.environ.get("TRIPL_CONF_CH_DB", "default")

_BQ_EMULATOR_URL = os.environ.get("TRIPL_CONF_BQ_EMULATOR_URL", "http://localhost:9050")
_BQ_PROJECT = os.environ.get("TRIPL_CONF_BQ_PROJECT", "tripl-test")

#: The table both executing warehouses seed. Distinctive enough that it cannot be
#: confused with anything a developer actually has.
TABLE = "tripl_conformance_events"

#: The non-UTC zone the PostgreSQL gate pins the *role* to, to prove the adapter's
#: session pin and explicit-offset literals survive a hostile server default.
PG_HOSTILE_TZ = "Asia/Kolkata"

_REQUIRED = os.environ.get("TRIPL_CONFORMANCE_REQUIRED") == "1"


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Mark everything in this package ``conformance``.

    Done here rather than per-module so a new test file cannot forget the marker
    and quietly start running (and failing) in the fast local suite.
    """
    for item in items:
        if "tests/conformance/" in item.nodeid or "tests\\conformance\\" in item.nodeid:
            item.add_marker(pytest.mark.conformance)


def unavailable(reason: str) -> NoReturn:
    """Skip locally, FAIL in CI. See the module docstring."""
    if _REQUIRED:
        pytest.fail(
            f"TRIPL_CONFORMANCE_REQUIRED=1 but the warehouse is unreachable: {reason}. "
            "A conformance gate that skips is a gate that reports green while "
            "testing nothing — fix the container, do not relax this."
        )
    pytest.skip(f"conformance warehouse unavailable: {reason}")


# --- PostgreSQL --------------------------------------------------------------


def _pg_adapter(**overrides: object) -> PostgresAdapter:
    return PostgresAdapter(
        host=_PG_HOST,
        port=_PG_PORT,
        database=_PG_DB,
        username=_PG_USER,
        password=_PG_PASSWORD,
        **overrides,
    )


def _seed_postgres(adapter: PostgresAdapter) -> None:
    conn = adapter._conn  # noqa: SLF001 — the gate seeds through the adapter's own connection
    with conn.cursor() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {TABLE}")
        cur.execute(
            f"CREATE TABLE {TABLE} ("
            "id integer PRIMARY KEY, "
            # The instant column. Its literals carry an explicit +00:00 offset.
            "ts timestamptz NOT NULL, "
            # The zone-less twin, holding the same UTC wall clock. Only the session
            # timezone pin can keep THIS column correct on a non-UTC server, so it
            # is what makes the hostile-timezone test bite.
            "ts_naive timestamp NOT NULL, "
            "event_name text NOT NULL, "
            "amount double precision, "
            "user_id text NOT NULL, "
            "doc jsonb"
            ")"
        )
        cur.executemany(
            f"INSERT INTO {TABLE} (id, ts, ts_naive, event_name, amount, user_id, doc) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)",
            [
                (
                    row.id,
                    row.ts,
                    row.ts.replace(tzinfo=None),
                    row.event_name,
                    row.amount,
                    row.user_id,
                    json.dumps(row.doc),
                )
                for row in ROWS
            ],
        )


#: Timezone names this fixture is allowed to set. `ALTER ROLE ... SET` is a utility
#: statement: PostgreSQL does NOT accept a bind parameter for its value ("syntax error
#: at or near $1"), so the zone has to be interpolated — and is therefore checked
#: against a closed list rather than trusted.
_ALLOWED_TIMEZONES = frozenset({"UTC", PG_HOSTILE_TZ})


def _set_pg_role_timezone(adapter: PostgresAdapter, zone: str) -> None:
    if zone not in _ALLOWED_TIMEZONES:
        raise ValueError(f"refusing to interpolate an unknown timezone: {zone!r}")
    with adapter._conn.cursor() as cur:  # noqa: SLF001
        cur.execute(f"ALTER ROLE \"{_PG_USER}\" SET timezone TO '{zone}'")
        cur.execute(f"ALTER DATABASE \"{_PG_DB}\" SET timezone TO '{zone}'")


@pytest.fixture(scope="session")
def pg() -> Iterator[PostgresAdapter]:
    """A live PostgresAdapter against a seeded ``postgres:18``."""
    try:
        adapter = _pg_adapter()
    except Exception as exc:  # noqa: BLE001 — any connect failure means "not available"
        unavailable(f"postgres at {_PG_HOST}:{_PG_PORT}/{_PG_DB}: {exc}")
    try:
        adapter.test_connection()
        _seed_postgres(adapter)
        yield adapter
    finally:
        adapter.close()


@pytest.fixture(scope="session")
def pg_hostile_tz() -> Iterator[Callable[[], PostgresAdapter]]:
    """A factory for adapters connecting to a server whose ROLE/DB timezone is not UTC.

    The zone is set on the role AND the database, so it is inherited by every new
    connection: nothing but the adapter's own ``-c timezone=UTC`` startup option and
    its explicit-offset literals can keep the window and the buckets correct. Reset
    afterwards so the hostile default cannot leak into another test.
    """
    admin = _pg_adapter()
    _set_pg_role_timezone(admin, PG_HOSTILE_TZ)
    try:
        yield _pg_adapter
    finally:
        _set_pg_role_timezone(admin, "UTC")
        admin.close()


# --- ClickHouse --------------------------------------------------------------

#: The fixture time column is declared in a NON-UTC timezone on purpose. This is the
#: regression that mattered most: the pre-fix adapter emitted an offset-less literal,
#: which ClickHouse reads as the COLUMN's wall clock, so a Tokyo-declared column
#: matched none of the window's rows. Verified on a live server.
CH_COLUMN_TZ = "Asia/Tokyo"


def _ch_adapter() -> ClickHouseAdapter:
    return ClickHouseAdapter(
        host=_CH_HOST,
        port=_CH_PORT,
        database=_CH_DB,
        username=os.environ.get("TRIPL_CONF_CH_USER", "default"),
        password=os.environ.get("TRIPL_CONF_CH_PASSWORD", ""),
        json_path_discovery="all",
    )


def _seed_clickhouse(adapter: ClickHouseAdapter) -> None:
    client = adapter._client  # noqa: SLF001
    settings = {"allow_experimental_json_type": 1}
    client.command(f"DROP TABLE IF EXISTS {TABLE}")
    client.command(
        f"CREATE TABLE {TABLE} ("
        "id UInt32, "
        f"ts DateTime64(6, '{CH_COLUMN_TZ}'), "
        "event_name String, "
        "amount Nullable(Float64), "
        "user_id String, "
        "doc JSON"
        ") ENGINE = MergeTree ORDER BY id",
        settings=settings,
    )

    def _row_literal(row: FixtureRow) -> str:
        # The instant is written with an explicit +00:00 and parsed to a UTC-pinned
        # DateTime64, so the SEEDING cannot itself be shifted by the column's Tokyo
        # timezone — the trap is for the adapter's SQL, not for the fixture loader.
        ts = row.ts.strftime("%Y-%m-%d %H:%M:%S.%f+00:00")
        amount = "NULL" if row.amount is None else repr(row.amount)
        doc = json.dumps(row.doc).replace("\\", "\\\\").replace("'", "\\'")
        return (
            f"({row.id}, parseDateTime64BestEffort('{ts}', 6, 'UTC'), "
            f"'{row.event_name}', {amount}, '{row.user_id}', '{doc}')"
        )

    values = ", ".join(_row_literal(row) for row in ROWS)
    client.command(f"INSERT INTO {TABLE} VALUES {values}", settings=settings)


@pytest.fixture(scope="session")
def ch() -> Iterator[ClickHouseAdapter]:
    """A live ClickHouseAdapter against a seeded ``clickhouse-server``."""
    try:
        adapter = _ch_adapter()
        adapter.test_connection()
        _seed_clickhouse(adapter)
    except Exception as exc:  # noqa: BLE001
        unavailable(f"clickhouse at {_CH_HOST}:{_CH_PORT}: {exc}")
    try:
        yield adapter
    finally:
        adapter.close()


# --- BigQuery emulator (analysis only) ---------------------------------------


def _post_query(sql: str) -> dict[str, object]:
    request = urllib.request.Request(  # noqa: S310 — fixed localhost emulator URL
        f"{_BQ_EMULATOR_URL}/bigquery/v2/projects/{_BQ_PROJECT}/queries",
        data=json.dumps({"query": sql, "useLegacySql": False}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            return dict(json.loads(response.read()))
    except urllib.error.HTTPError as exc:
        return dict(json.loads(exc.read()))


def _analysis_error(sql: str) -> str | None:
    """``None`` if ZetaSQL accepts the statement, else the analyzer's message."""
    body = _post_query(sql)
    error = body.get("error")
    if not error:
        return None
    if isinstance(error, dict):
        return str(error.get("message", error))
    return str(error)


@pytest.fixture(scope="session")
def bq_analyze() -> Callable[[str], str | None]:
    """Submit GoogleSQL to the emulator's real ZetaSQL analyzer; return its verdict.

    Do NOT use the ``google-cloud-bigquery`` Python client against the emulator — it
    hangs. Plain REST only.
    """
    try:
        probe = _analysis_error("SELECT 1 AS x")
    except OSError as exc:
        unavailable(f"bigquery-emulator at {_BQ_EMULATOR_URL}: {exc}")
    if probe is not None:
        unavailable(f"bigquery-emulator at {_BQ_EMULATOR_URL} rejected SELECT 1: {probe}")
    return _analysis_error
