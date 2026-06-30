from __future__ import annotations

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
    # Hardening: per-query server-side execution cap is scoped to this query.
    assert client.settings[0] == {"max_execution_time": 30}
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

# BigQuery introspection stays scoped to the connection's default dataset (see
# BigQueryAdapter.get_schema_tables for why), so every table is returned bare.
_BQ_CATALOG_ROWS: list[tuple[object, ...]] = [
    ("events", "id", "INT64"),
    ("events", "name", "STRING"),
    ("users", "email", "STRING"),
]


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
    def __init__(self, rows: list[tuple[object, ...]], client: _BQClient) -> None:
        self._rows = rows
        self._client = client

    def result(self, timeout: float | None = None) -> _BQResult:
        self._client.result_timeouts.append(timeout)
        return _BQResult(self._rows)


class _BQClient:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self.sql: list[str] = []
        self.result_timeouts: list[float | None] = []
        self._rows = rows

    def query(self, sql: str) -> _BQJob:
        self.sql.append(sql)
        return _BQJob(self._rows, self)


def _bigquery_adapter(rows: list[tuple[object, ...]]) -> tuple[BigQueryAdapter, _BQClient]:
    client = _BQClient(rows)
    adapter = object.__new__(BigQueryAdapter)
    adapter._client = client
    adapter._project = "my-project"
    adapter._dataset = "analytics"
    adapter._allowed_columns = set()
    return adapter, client


def test_bigquery_schema_uses_information_schema_columns() -> None:
    adapter, client = _bigquery_adapter(_BQ_CATALOG_ROWS)

    tables = adapter.get_schema_tables()

    sql = client.sql[0]
    assert "`my-project.analytics.INFORMATION_SCHEMA.COLUMNS`" in sql
    assert "LIMIT 50000" in sql
    # Hardening: wall-clock timeout is scoped to the schema introspection job.
    assert client.result_timeouts == [30]
    # Single-dataset scope: every table is returned bare (no `dataset.` prefix).
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


def test_bigquery_schema_rejects_invalid_project() -> None:
    adapter, _client = _bigquery_adapter(_BQ_CATALOG_ROWS)
    adapter._project = "bad project; DROP"

    import pytest

    with pytest.raises(ValueError, match="project"):
        adapter.get_schema_tables()


def test_bigquery_schema_rejects_overlong_dataset() -> None:
    # Hardening: a pathologically long (but char-class-valid) id is rejected
    # before it can reach logs/SQL.
    adapter, _client = _bigquery_adapter(_BQ_CATALOG_ROWS)
    adapter._dataset = "a" * 1025

    import pytest

    with pytest.raises(ValueError, match="dataset"):
        adapter.get_schema_tables()
