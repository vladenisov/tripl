from __future__ import annotations

import re

import pytest

from tripl.core.adapters.base import SchemaColumn, SchemaTable
from tripl.core.adapters.bigquery import BigQueryAdapter
from tripl.core.adapters.clickhouse import ClickHouseAdapter
from tripl.core.adapters.postgres import PostgresAdapter

# --- ClickHouse -------------------------------------------------------------

# Rows shaped as the CH catalog query returns them:
# (database, table, column, type, is_current_database), already ordered by
# (database, table, position) so grouping preserves column order. Tables in the
# current/default database (is_current_database = 1) stay bare; tables in any
# other database are qualified `database.table`.
_CH_CATALOG_ROWS: list[tuple[object, ...]] = [
    ("analytics", "orders", "amount", "Float64", 0),
    ("analytics", "orders", "currency", "String", 0),
    ("default", "events", "id", "UInt64", 1),
    ("default", "events", "name", "String", 1),
]


class _CHResult:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self.result_rows = rows


class _CHClient:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self.sql: list[str] = []
        self.settings: list[dict[str, object] | None] = []
        self._rows = rows

    def query(self, sql: str, settings: dict[str, object] | None = None) -> _CHResult:
        self.sql.append(sql)
        self.settings.append(settings)
        return _CHResult(self._rows)


def _clickhouse_adapter(rows: list[tuple[object, ...]]) -> tuple[ClickHouseAdapter, _CHClient]:
    client = _CHClient(rows)
    adapter = object.__new__(ClickHouseAdapter)
    adapter._client = client
    adapter._allowed_columns = set()
    return adapter, client


def test_clickhouse_schema_spans_all_databases_with_qualified_names() -> None:
    adapter, client = _clickhouse_adapter(_CH_CATALOG_ROWS)

    tables = adapter.get_schema_tables()

    sql = client.sql[0]
    assert "FROM system.columns" in sql
    # The bare-vs-qualified decision is computed server-side against the
    # connection's current database, so it is robust to an empty/`default` one.
    assert "database = currentDatabase()" in sql
    # System databases are excluded so only queryable user tables surface.
    assert "NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')" in sql
    assert "LIMIT 50000" in sql
    # No per-query settings: tripl uses read-only ClickHouse users, which reject
    # setting overrides; the row LIMIT + connection timeout bound the query.
    assert client.settings[0] is None
    # Other-database tables are qualified; current-database tables stay bare.
    assert tables == [
        SchemaTable(
            name="analytics.orders",
            columns=[
                SchemaColumn(name="amount", data_type="Float64"),
                SchemaColumn(name="currency", data_type="String"),
            ],
        ),
        SchemaTable(
            name="events",
            columns=[
                SchemaColumn(name="id", data_type="UInt64"),
                SchemaColumn(name="name", data_type="String"),
            ],
        ),
    ]


def test_clickhouse_schema_keeps_current_database_tables_bare() -> None:
    # Every table lives in the current database, so none is qualified.
    rows: list[tuple[object, ...]] = [
        ("default", "events", "id", "UInt64", 1),
        ("default", "events", "name", "String", 1),
        ("default", "users", "email", "String", 1),
    ]
    adapter, _client = _clickhouse_adapter(rows)

    tables = adapter.get_schema_tables()

    assert [table.name for table in tables] == ["events", "users"]
    assert all("." not in table.name for table in tables)


# --- Postgres ---------------------------------------------------------------

# Rows shaped as the PG catalog query returns them:
# (table_schema, table_name, column_name, data_type, is_current_schema),
# ordered by (table_schema, table_name, ordinal_position). Tables in the default
# schema (is_current_schema = True) stay bare; others are qualified
# `schema.table`.
_PG_CATALOG_ROWS: list[tuple[object, ...]] = [
    ("analytics", "orders", "amount", "numeric", False),
    ("public", "events", "id", "bigint", True),
    ("public", "events", "name", "text", True),
]


class _PGCursor:
    def __init__(self, parent: _PGConn) -> None:
        self._parent = parent

    def __enter__(self) -> _PGCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def execute(self, sql: str) -> None:
        self._parent.sql.append(sql)

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._parent.rows


class _PGConn:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self.sql: list[str] = []
        self.rows = rows

    def cursor(self) -> _PGCursor:
        return _PGCursor(self)


def _postgres_adapter(rows: list[tuple[object, ...]]) -> tuple[PostgresAdapter, _PGConn]:
    conn = _PGConn(rows)
    adapter = object.__new__(PostgresAdapter)
    adapter._conn = conn
    adapter._allowed_columns = set()
    return adapter, conn


def test_postgres_schema_spans_all_schemas_with_qualified_names() -> None:
    adapter, conn = _postgres_adapter(_PG_CATALOG_ROWS)

    tables = adapter.get_schema_tables()

    sql = conn.sql[0]
    assert "FROM information_schema.columns" in sql
    # The bare-vs-qualified decision tracks the connection's default schema.
    assert "current_schema()" in sql
    # System schemas are excluded so only queryable user tables surface.
    assert "NOT IN ('pg_catalog', 'information_schema')" in sql
    assert "LIMIT 50000" in sql
    # Non-default-schema tables are qualified; default-schema tables stay bare.
    assert tables == [
        SchemaTable(
            name="analytics.orders",
            columns=[SchemaColumn(name="amount", data_type="numeric")],
        ),
        SchemaTable(
            name="events",
            columns=[
                SchemaColumn(name="id", data_type="bigint"),
                SchemaColumn(name="name", data_type="text"),
            ],
        ),
    ]


def test_postgres_schema_keeps_default_schema_tables_bare() -> None:
    rows: list[tuple[object, ...]] = [
        ("public", "events", "id", "bigint", True),
        ("public", "users", "email", "text", True),
    ]
    adapter, _conn = _postgres_adapter(rows)

    tables = adapter.get_schema_tables()

    assert [table.name for table in tables] == ["events", "users"]
    assert all("." not in table.name for table in tables)


# --- BigQuery ---------------------------------------------------------------

# BigQuery's INFORMATION_SCHEMA.COLUMNS view is dataset-qualified, so unlike the single
# catalog query ClickHouse and Postgres each issue, covering N datasets costs N jobs.
# The rows below are keyed by dataset so the fake can answer each of those jobs with the
# tables that dataset actually holds.
_BQ_CATALOG_ROWS: dict[str, list[tuple[object, ...]]] = {
    "analytics": [
        ("events", "id", "INT64"),
        ("events", "name", "STRING"),
        ("users", "email", "STRING"),
    ],
    "raw": [("orders", "amount", "NUMERIC")],
    "archive": [("events_2024", "id", "INT64")],
}

_BQ_DATASET_RE = re.compile(r"`my-project\.(\w+)\.INFORMATION_SCHEMA\.COLUMNS`")


class _BQField:
    def __init__(self, name: str) -> None:
        self.name = name


class _BQRow:
    def __init__(self, values: tuple[object, ...]) -> None:
        self._values = values

    def values(self) -> tuple[object, ...]:
        return self._values


class _BQResult:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self.schema = [_BQField("table_name"), _BQField("column_name"), _BQField("data_type")]
        self._rows = rows

    def __iter__(self):
        return iter(_BQRow(r) for r in self._rows)


class _BQJob:
    def __init__(self, dataset: str, client: _BQClient) -> None:
        self._dataset = dataset
        self._client = client

    def result(self, timeout: float | None = None) -> _BQResult:
        self._client.result_timeouts.append(timeout)
        if self._dataset in self._client.denied:
            msg = f"Access Denied: Dataset my-project:{self._dataset}"
            raise PermissionError(msg)
        return _BQResult(self._client.rows.get(self._dataset, []))


class _BQClient:
    """One job per dataset; a dataset in ``denied`` refuses, as a real one would."""

    def __init__(
        self,
        rows: dict[str, list[tuple[object, ...]]],
        denied: set[str] | None = None,
    ) -> None:
        self.sql: list[str] = []
        self.result_timeouts: list[float | None] = []
        self.rows = rows
        self.denied = denied or set()

    def query(self, sql: str) -> _BQJob:
        self.sql.append(sql)
        match = _BQ_DATASET_RE.search(sql)
        assert match, f"catalog query did not name a dataset: {sql}"
        return _BQJob(match.group(1), self)


def _bigquery_adapter(
    rows: dict[str, list[tuple[object, ...]]],
    *,
    allowlist: tuple[str, ...] | None = None,
    denied: set[str] | None = None,
) -> tuple[BigQueryAdapter, _BQClient]:
    client = _BQClient(rows, denied)
    adapter = object.__new__(BigQueryAdapter)
    adapter._client = client
    adapter._project = "my-project"
    adapter._dataset = "analytics"
    adapter._allowed_columns = set()
    if allowlist is not None:
        adapter._dataset_allowlist = allowlist
    return adapter, client


def _browsed_datasets(client: _BQClient) -> list[str]:
    return [match.group(1) for sql in client.sql if (match := _BQ_DATASET_RE.search(sql))]


def test_bigquery_schema_defaults_to_the_connections_dataset_only() -> None:
    # With no allowlist configured the browse is exactly the single default dataset — the
    # pre-existing behavior and the pre-existing cost. Turning multi-dataset browse on
    # must not silently multiply the job count for every existing BigQuery source.
    adapter, client = _bigquery_adapter(_BQ_CATALOG_ROWS)

    tables = adapter.get_schema_tables()

    assert _browsed_datasets(client) == ["analytics"]
    assert "`my-project.analytics.INFORMATION_SCHEMA.COLUMNS`" in client.sql[0]
    assert "LIMIT 50000" in client.sql[0]
    # Wall-clock cap on the introspection job so a hung BQ job can't pin the worker.
    assert client.result_timeouts == [30]
    # Everything is inside the default dataset, so every name stays bare.
    assert tables == [
        SchemaTable(
            name="events",
            columns=[
                SchemaColumn(name="id", data_type="INT64"),
                SchemaColumn(name="name", data_type="STRING"),
            ],
        ),
        SchemaTable(
            name="users",
            columns=[SchemaColumn(name="email", data_type="STRING")],
        ),
    ]


def test_bigquery_schema_spans_the_allowlist_with_qualified_names() -> None:
    # Same convention ClickHouse and Postgres already follow, and the one the frontend
    # depends on: a table name carries at most one dot, and only when it lives outside
    # the connection's default dataset.
    adapter, client = _bigquery_adapter(_BQ_CATALOG_ROWS, allowlist=("raw", "archive", "analytics"))

    tables = adapter.get_schema_tables()

    # The default dataset is browsed first and the rest are sorted, so the result does
    # not depend on the order the allowlist happened to be saved in.
    assert _browsed_datasets(client) == ["analytics", "archive", "raw"]
    assert [table.name for table in tables] == [
        "events",
        "users",
        "archive.events_2024",
        "raw.orders",
    ]
    assert all(table.name.count(".") <= 1 for table in tables)


def test_bigquery_schema_does_not_double_browse_the_default_dataset() -> None:
    adapter, client = _bigquery_adapter(_BQ_CATALOG_ROWS, allowlist=("analytics", "analytics"))

    adapter.get_schema_tables()

    assert _browsed_datasets(client) == ["analytics"]


def test_bigquery_schema_survives_a_dataset_it_cannot_read() -> None:
    # A permission failure on ONE dataset must not destroy the results from the others.
    adapter, client = _bigquery_adapter(
        _BQ_CATALOG_ROWS, allowlist=("raw", "archive"), denied={"archive"}
    )

    tables = adapter.get_schema_tables()

    assert _browsed_datasets(client) == ["analytics", "archive", "raw"]
    assert [table.name for table in tables] == ["events", "users", "raw.orders"]


def test_bigquery_schema_raises_when_every_dataset_fails() -> None:
    # Returning an empty catalog here would look exactly like "this project has no
    # tables", which is the wrong thing to tell a user staring at empty autocomplete.
    adapter, _client = _bigquery_adapter(
        _BQ_CATALOG_ROWS, allowlist=("raw",), denied={"analytics", "raw"}
    )

    with pytest.raises(PermissionError, match="Access Denied"):
        adapter.get_schema_tables()


def test_bigquery_schema_row_budget_is_shared_across_datasets() -> None:
    # 50,000 rows is the budget for the WHOLE browse, not a per-dataset allowance: the
    # LIMIT shrinks as each dataset spends from it.
    adapter, client = _bigquery_adapter(_BQ_CATALOG_ROWS, allowlist=("raw", "archive"))

    adapter.get_schema_tables()

    limits = [int(sql.rsplit("LIMIT ", 1)[1]) for sql in client.sql]
    # analytics returns 3 rows, then archive 1.
    assert limits == [50000, 49997, 49996]


def test_bigquery_schema_caps_the_number_of_jobs() -> None:
    # An autocomplete keystroke must never fan out into an unbounded number of billed jobs.
    allowlist = tuple(f"ds{index:03d}" for index in range(50))
    adapter, client = _bigquery_adapter({}, allowlist=allowlist)

    adapter.get_schema_tables()

    assert len(client.sql) == 20
    # ...and the connection's own dataset is never the one squeezed out.
    assert _browsed_datasets(client)[0] == "analytics"


def test_bigquery_schema_rejects_invalid_project() -> None:
    adapter, _client = _bigquery_adapter(_BQ_CATALOG_ROWS)
    adapter._project = "bad project; DROP"

    with pytest.raises(ValueError, match="project"):
        adapter.get_schema_tables()


def test_bigquery_schema_rejects_overlong_dataset() -> None:
    # Hardening: a pathologically long (but char-class-valid) id is rejected
    # before it can reach logs/SQL.
    adapter, _client = _bigquery_adapter(_BQ_CATALOG_ROWS)
    adapter._dataset = "a" * 1025

    with pytest.raises(ValueError, match="dataset"):
        adapter.get_schema_tables()


@pytest.mark.parametrize("bad", ["other-project.ds", "ds; DROP TABLE t", "a" * 1025, "ds ds"])
def test_bigquery_schema_validates_allowlisted_datasets_too(bad: str) -> None:
    # The allowlist is a NEW way to reach the catalog-query interpolation, so it must not
    # be a new way to weaken the identifier validation that guards it.
    adapter, client = _bigquery_adapter(_BQ_CATALOG_ROWS, allowlist=(bad,))

    with pytest.raises(ValueError, match="dataset"):
        adapter.get_schema_tables()
    assert client.sql == []
