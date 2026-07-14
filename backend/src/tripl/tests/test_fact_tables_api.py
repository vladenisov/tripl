"""API-level tests for the FactTable CRUD catalog + preview (tripl-ysji.3)."""

import uuid
from types import SimpleNamespace

import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from tripl.models.scan_config import ScanConfig
from tripl.schemas.fact_table import FactTableCreate
from tripl.tests.conftest import TestSessionLocal


async def _bind_data_source_to_project(project_id: str, data_source_id: str) -> None:
    """Bind a data source to a project via a ScanConfig (its membership link).

    The create/update persist path now scopes a supplied ``data_source_id`` to
    the project through ``ScanConfig`` (multi-tenant isolation), so a fact table
    can only reference a warehouse the project already uses.
    """
    async with TestSessionLocal() as session:
        session.add(
            ScanConfig(
                project_id=uuid.UUID(project_id),
                data_source_id=uuid.UUID(data_source_id),
                name="scan-binding",
                base_query="SELECT 1",
            )
        )
        await session.commit()


@pytest.fixture
async def project(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "Fact Tables Test", "slug": "fact-tables-test", "description": ""},
    )
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
async def data_source(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": "Test CH",
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "test_db",
        },
    )
    assert resp.status_code == 201
    return resp.json()


def _fact_tables_url(slug: str) -> str:
    return f"/api/v1/projects/{slug}/fact-tables"


async def _create_fact_table(
    client: AsyncClient,
    slug: str,
    name: str,
    **extra: object,
) -> dict:
    payload: dict = {
        "name": name,
        "display_name": name.upper(),
        "sql": "SELECT id, user_id, amount, created_at FROM orders",
        "timestamp_column": "created_at",
        "columns": [
            {"name": "amount", "type": "number"},
            {"name": "user_id", "type": "string"},
        ],
        "identifier_columns": ["user_id"],
        "row_filters": [{"name": "paid", "sql": "status = 'paid'"}],
        **extra,
    }
    resp = await client.post(_fact_tables_url(slug), json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestCrudLifecycle:
    async def test_create_list_get_update_delete(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        await _bind_data_source_to_project(project["id"], data_source["id"])

        # Create
        created = await _create_fact_table(client, slug, "orders", data_source_id=data_source["id"])
        assert created["name"] == "orders"
        assert created["display_name"] == "ORDERS"
        assert created["data_source_id"] == data_source["id"]
        assert created["timestamp_column"] == "created_at"
        assert created["columns"] == [
            {"name": "amount", "type": "number"},
            {"name": "user_id", "type": "string"},
        ]
        assert created["identifier_columns"] == ["user_id"]
        assert created["row_filters"] == [{"name": "paid", "sql": "status = 'paid'"}]
        assert created["color"] == "#6366f1"
        assert created["project_id"] == project["id"]
        fact_table_id = created["id"]

        # List
        listing = await client.get(_fact_tables_url(slug))
        assert listing.status_code == 200, listing.text
        body = listing.json()
        assert body["total"] == 1
        assert body["items"][0]["id"] == fact_table_id
        assert body["items"][0]["name"] == "orders"

        # Get
        fetched = await client.get(f"{_fact_tables_url(slug)}/{fact_table_id}")
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["sql"].startswith("SELECT id, user_id")

        # Update
        updated = await client.patch(
            f"{_fact_tables_url(slug)}/{fact_table_id}",
            json={
                "display_name": "Orders v2",
                "timestamp_column": "updated_at",
                "identifier_columns": ["user_id", "account_id"],
            },
        )
        assert updated.status_code == 200, updated.text
        data = updated.json()
        assert data["display_name"] == "Orders v2"
        assert data["timestamp_column"] == "updated_at"
        assert data["identifier_columns"] == ["user_id", "account_id"]

        # Delete
        deleted = await client.delete(f"{_fact_tables_url(slug)}/{fact_table_id}")
        assert deleted.status_code == 204
        missing = await client.get(f"{_fact_tables_url(slug)}/{fact_table_id}")
        assert missing.status_code == 404

    async def test_create_without_data_source(self, client: AsyncClient, project: dict):
        created = await _create_fact_table(client, project["slug"], "no_source")
        assert created["data_source_id"] is None

    async def test_order_appends_at_end(self, client: AsyncClient, project: dict):
        first = await _create_fact_table(client, project["slug"], "first")
        second = await _create_fact_table(client, project["slug"], "second")
        assert second["order"] > first["order"]


class TestDataSourceScoping:
    """A fact table may only bind a data source the project already uses."""

    async def test_create_rejects_data_source_not_in_project(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        # The data source exists globally but is NOT bound to this project via a
        # ScanConfig, so the persist path must refuse the cross-project binding.
        resp = await client.post(
            _fact_tables_url(project["slug"]),
            json={
                "name": "leaky",
                "display_name": "Leaky",
                "sql": "SELECT id, ts FROM t",
                "timestamp_column": "ts",
                "data_source_id": data_source["id"],
            },
        )
        assert resp.status_code == 404, resp.text

    async def test_update_rejects_data_source_not_in_project(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        created = await _create_fact_table(client, project["slug"], "no_source")
        resp = await client.patch(
            f"{_fact_tables_url(project['slug'])}/{created['id']}",
            json={"data_source_id": data_source["id"]},
        )
        assert resp.status_code == 404, resp.text

    async def test_create_accepts_bound_data_source(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        await _bind_data_source_to_project(project["id"], data_source["id"])
        created = await _create_fact_table(
            client, project["slug"], "bound", data_source_id=data_source["id"]
        )
        assert created["data_source_id"] == data_source["id"]


class TestConflictsAndValidation:
    async def test_reject_explicit_null_order_on_update(self, client: AsyncClient, project: dict):
        # ``order`` maps to a NOT NULL column; an explicit null must be rejected
        # at the schema boundary (422), not surface as a DB-level 500.
        created = await _create_fact_table(client, project["slug"], "ordered")
        resp = await client.patch(
            f"{_fact_tables_url(project['slug'])}/{created['id']}",
            json={"order": None},
        )
        assert resp.status_code == 422, resp.text

    async def test_duplicate_name_conflict(self, client: AsyncClient, project: dict):
        await _create_fact_table(client, project["slug"], "dup")
        resp = await client.post(
            _fact_tables_url(project["slug"]),
            json={
                "name": "dup",
                "display_name": "Dup 2",
                "sql": "SELECT id, ts FROM t",
                "timestamp_column": "ts",
            },
        )
        assert resp.status_code == 409, resp.text

    async def test_reject_unsafe_sql_at_api(self, client: AsyncClient, project: dict):
        resp = await client.post(
            _fact_tables_url(project["slug"]),
            json={
                "name": "bad_sql",
                "display_name": "Bad SQL",
                "sql": "SELECT * FROM users UNION SELECT secret FROM admin",
                "timestamp_column": "ts",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_bad_timestamp_identifier(self, client: AsyncClient, project: dict):
        resp = await client.post(
            _fact_tables_url(project["slug"]),
            json={
                "name": "bad_ts",
                "display_name": "Bad TS",
                "sql": "SELECT id, ts FROM t",
                "timestamp_column": "ts; DROP TABLE x --",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_row_filter_injection(self, client: AsyncClient, project: dict):
        resp = await client.post(
            _fact_tables_url(project["slug"]),
            json={
                "name": "bad_filter",
                "display_name": "Bad Filter",
                "sql": "SELECT id, ts FROM t",
                "timestamp_column": "ts",
                "row_filters": [{"name": "evil", "sql": "1=1 UNION SELECT secret FROM users"}],
            },
        )
        assert resp.status_code == 422, resp.text


class TestSchemaBoundary:
    """The schema is the only gate before warehouse SQL with no bound params."""

    def test_sql_safety_rejects_union(self):
        with pytest.raises(ValidationError):
            FactTableCreate(
                name="x",
                display_name="X",
                sql="SELECT a FROM t UNION SELECT b FROM u",
                timestamp_column="ts",
            )

    def test_sql_safety_rejects_stacked_statement(self):
        with pytest.raises(ValidationError):
            FactTableCreate(
                name="x",
                display_name="X",
                sql="SELECT a FROM t; DROP TABLE u",
                timestamp_column="ts",
            )

    def test_identifier_column_rejects_injection(self):
        with pytest.raises(ValidationError):
            FactTableCreate(
                name="x",
                display_name="X",
                sql="SELECT a, ts FROM t",
                timestamp_column="ts",
                identifier_columns=["user_id", "bad col"],
            )

    def test_valid_select_is_accepted(self):
        model = FactTableCreate(
            name="x",
            display_name="X",
            sql="SELECT a, ts FROM t",
            timestamp_column="ts",
        )
        assert model.to_create_values()["sql"] == "SELECT a, ts FROM t"


class TestPreview:
    async def test_preview_maps_introspection(
        self, monkeypatch: pytest.MonkeyPatch, client: AsyncClient, project: dict
    ):
        # The introspection service is a sibling slice; skip cleanly until it
        # lands, then run with a monkeypatched, warehouse-free stand-in.
        introspection_mod = pytest.importorskip("tripl.services.fact_table_introspection_service")

        canned = SimpleNamespace(
            columns=[
                SimpleNamespace(name="amount", type="number", native_type="Float64"),
                SimpleNamespace(name="user_id", type="string", native_type="String"),
            ],
            identifier_candidates=["user_id"],
            sample_rows=[{"amount": 1, "user_id": "u1"}],
        )

        async def fake_introspect(
            session: object,
            *,
            project_id: object,
            data_source_id: object,
            sql: str,
            timestamp_column: object,
        ) -> SimpleNamespace:
            return canned

        monkeypatch.setattr(introspection_mod, "introspect_fact_table", fake_introspect)

        resp = await client.post(
            f"{_fact_tables_url(project['slug'])}/preview",
            json={"sql": "SELECT amount, user_id FROM orders", "timestamp_column": None},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["columns"] == [
            {"name": "amount", "type": "number", "native_type": "Float64"},
            {"name": "user_id", "type": "string", "native_type": "String"},
        ]
        assert body["identifier_candidates"] == ["user_id"]
        assert body["sample_rows"] == [{"amount": 1, "user_id": "u1"}]
