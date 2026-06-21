from __future__ import annotations

from tripl.core.adapters.base import SchemaColumn, SchemaTable
from tripl.core.adapters.bigquery import BigQueryAdapter
from tripl.core.adapters.clickhouse import ClickHouseAdapter
from tripl.core.adapters.postgres import PostgresAdapter

# Rows shaped as the catalog queries return them: (table, column, type),
# already ordered by (table, position) so grouping preserves column order.
_CATALOG_ROWS: list[tuple[object, ...]] = [
    ("events", "id", "UInt64"),
    ("events", "name", "String"),
    ("users", "email", "String"),
]


# --- ClickHouse -------------------------------------------------------------


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


def test_clickhouse_schema_uses_system_columns() -> None:
    adapter, client = _clickhouse_adapter(_CATALOG_ROWS)

    tables = adapter.get_schema_tables()

    sql = client.sql[0]
    assert "FROM system.columns" in sql
    assert "WHERE database = currentDatabase()" in sql
    assert "LIMIT 5000" in sql
    # Hardening: per-query server-side execution cap is scoped to this query.
    assert client.settings[0] == {"max_execution_time": 30}
    _assert_grouped(tables)


# --- Postgres ---------------------------------------------------------------


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


def test_postgres_schema_uses_information_schema() -> None:
    adapter, conn = _postgres_adapter(_CATALOG_ROWS)

    tables = adapter.get_schema_tables()

    sql = conn.sql[0]
    assert "FROM information_schema.columns" in sql
    assert "current_schemas(false)" in sql
    assert "LIMIT 5000" in sql
    _assert_grouped(tables)


# --- BigQuery ---------------------------------------------------------------


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
    adapter, client = _bigquery_adapter(_CATALOG_ROWS)

    tables = adapter.get_schema_tables()

    sql = client.sql[0]
    assert "`my-project.analytics.INFORMATION_SCHEMA.COLUMNS`" in sql
    assert "LIMIT 5000" in sql
    # Hardening: wall-clock timeout is scoped to the schema introspection job.
    assert client.result_timeouts == [30]
    _assert_grouped(tables)


def test_bigquery_schema_rejects_invalid_project() -> None:
    adapter, _client = _bigquery_adapter(_CATALOG_ROWS)
    adapter._project = "bad project; DROP"

    import pytest

    with pytest.raises(ValueError, match="project"):
        adapter.get_schema_tables()


def test_bigquery_schema_rejects_overlong_dataset() -> None:
    # Hardening: a pathologically long (but char-class-valid) id is rejected
    # before it can reach logs/SQL.
    adapter, _client = _bigquery_adapter(_CATALOG_ROWS)
    adapter._dataset = "a" * 1025

    import pytest

    with pytest.raises(ValueError, match="dataset"):
        adapter.get_schema_tables()


# --- Shared grouping assertion ----------------------------------------------


def _assert_grouped(tables: list[SchemaTable]) -> None:
    assert tables == [
        SchemaTable(
            name="events",
            columns=[
                SchemaColumn(name="id", data_type="UInt64"),
                SchemaColumn(name="name", data_type="String"),
            ],
        ),
        SchemaTable(
            name="users",
            columns=[SchemaColumn(name="email", data_type="String")],
        ),
    ]
