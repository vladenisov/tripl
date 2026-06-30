import uuid

import pytest
from httpx import AsyncClient


@pytest.fixture
async def project(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "Metrics Test", "slug": "metrics-test", "description": ""},
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


@pytest.fixture
async def fact_table(client: AsyncClient, project: dict) -> dict:
    resp = await client.post(
        f"/api/v1/projects/{project['slug']}/fact-tables",
        json={
            "name": "orders_ft",
            "display_name": "Orders",
            "sql": "SELECT created_at, amount, user_id FROM orders",
            "timestamp_column": "created_at",
            "columns": [
                {"name": "created_at", "type": "timestamp"},
                {"name": "amount", "type": "number"},
                {"name": "user_id", "type": "string"},
            ],
            "identifier_columns": ["user_id"],
            "row_filters": [{"name": "exclude_test", "sql": "is_test = 0"}],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.fixture
async def event_type(client: AsyncClient, project: dict) -> dict:
    resp = await client.post(
        f"/api/v1/projects/{project['slug']}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
async def event(client: AsyncClient, project: dict, event_type: dict) -> dict:
    resp = await client.post(
        f"/api/v1/projects/{project['slug']}/events",
        json={"event_type_id": event_type["id"], "name": "signup"},
    )
    assert resp.status_code == 201
    return resp.json()


def _metrics_url(slug: str) -> str:
    return f"/api/v1/projects/{slug}/metrics"


async def _create_sql_metric(
    client: AsyncClient,
    slug: str,
    data_source_id: str,
    name: str,
    **extra: object,
) -> dict:
    payload: dict = {
        "kind": "sql",
        "name": name,
        "display_name": name.upper(),
        "data_source_id": data_source_id,
        "interval": "1d",
        "config": {"metric_sql": "SELECT 1 AS v, now() AS t", "time_column": "t"},
        **extra,
    }
    resp = await client.post(_metrics_url(slug), json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _create_multi_filter_fact_table(client: AsyncClient, slug: str) -> dict:
    """A fact table with two named row filters (for multi-filter metric tests)."""
    resp = await client.post(
        f"/api/v1/projects/{slug}/fact-tables",
        json={
            "name": "orders_multi_ft",
            "display_name": "Orders Multi",
            "sql": "SELECT created_at, amount, user_id FROM orders",
            "timestamp_column": "created_at",
            "columns": [
                {"name": "created_at", "type": "timestamp"},
                {"name": "amount", "type": "number"},
                {"name": "user_id", "type": "string"},
            ],
            "identifier_columns": ["user_id"],
            "row_filters": [
                {"name": "positive", "sql": "amount > 0"},
                {"name": "big", "sql": "amount > 100"},
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestCreateHappyPaths:
    async def test_create_fact_single_sum(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "revenue",
                "display_name": "Revenue",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "sum",
                "interval": "1h",
                "measure_column": "amount",
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["kind"] == "fact"
        assert data["aggregation"] == "sum"
        assert data["composition"] == "single"
        assert data["fact_table_id"] == fact_table["id"]
        # The data source is taken from the fact table, not stored on the metric.
        assert data["data_source_id"] is None
        assert data["interval"] == "1h"
        assert data["config"]["measure_column"] == "amount"
        assert data["status"] == "draft"
        assert data["project_id"] == project["id"]

    async def test_create_fact_single_count_without_measure(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "orders_count",
                "display_name": "Orders",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count",
                "interval": "1d",
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["config"].get("measure_column") is None

    async def test_create_fact_single_with_row_filter(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "clean_revenue",
                "display_name": "Clean Revenue",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "sum",
                "interval": "1h",
                "measure_column": "amount",
                "row_filter": "exclude_test",
            },
        )
        assert resp.status_code == 201, resp.text
        # Legacy single ``row_filter`` is folded into the effective ``row_filters``.
        config = resp.json()["config"]
        assert config["row_filters"] == ["exclude_test"]
        assert config["filter_sql"] is None

    async def test_create_fact_single_with_multiple_row_filters(
        self, client: AsyncClient, project: dict
    ):
        fact_table = await _create_multi_filter_fact_table(client, project["slug"])
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "big_positive_orders",
                "display_name": "Big positive orders",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count",
                "interval": "1h",
                "row_filters": ["positive", "big"],
            },
        )
        assert resp.status_code == 201, resp.text
        config = resp.json()["config"]
        assert config["row_filters"] == ["positive", "big"]
        assert config["filter_sql"] is None

    async def test_create_fact_single_with_filter_sql(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "free_text_revenue",
                "display_name": "Free-text Revenue",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "sum",
                "interval": "1h",
                "measure_column": "amount",
                "filter_sql": "amount > 0",
            },
        )
        assert resp.status_code == 201, resp.text
        config = resp.json()["config"]
        assert config["row_filters"] == []
        assert config["filter_sql"] == "amount > 0"

    async def test_create_fact_single_with_row_filters_and_filter_sql(
        self, client: AsyncClient, project: dict
    ):
        fact_table = await _create_multi_filter_fact_table(client, project["slug"])
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "combo_filtered",
                "display_name": "Combo filtered",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count",
                "interval": "1h",
                "row_filters": ["positive"],
                "filter_sql": "amount < 1000",
            },
        )
        assert resp.status_code == 201, resp.text
        config = resp.json()["config"]
        assert config["row_filters"] == ["positive"]
        assert config["filter_sql"] == "amount < 1000"

    async def test_create_fact_ratio_cross_fact_table(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        # A second fact table for the denominator: the ratio may span two tables.
        other = await client.post(
            f"/api/v1/projects/{project['slug']}/fact-tables",
            json={
                "name": "sessions_ft",
                "display_name": "Sessions",
                "sql": "SELECT started_at, session_id FROM sessions",
                "timestamp_column": "started_at",
                "columns": [
                    {"name": "started_at", "type": "timestamp"},
                    {"name": "session_id", "type": "string"},
                ],
                "identifier_columns": ["session_id"],
                "row_filters": [],
            },
        )
        assert other.status_code == 201, other.text
        denominator_ft = other.json()

        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "orders_per_session",
                "display_name": "Orders / session",
                "composition": "ratio",
                "interval": "1h",
                "numerator": {"fact_table_id": fact_table["id"], "aggregation": "count"},
                "denominator": {
                    "fact_table_id": denominator_ft["id"],
                    "aggregation": "count_distinct",
                    "distinct_column": "session_id",
                },
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["composition"] == "ratio"
        # The numerator operand mirrors onto the catalog fact_table_id / aggregation.
        assert data["fact_table_id"] == fact_table["id"]
        assert data["aggregation"] == "count"
        assert data["config"]["numerator"]["fact_table_id"] == fact_table["id"]
        assert data["config"]["denominator"]["fact_table_id"] == denominator_ft["id"]
        assert data["config"]["denominator"]["distinct_column"] == "session_id"

    async def test_create_sql_metric(self, client: AsyncClient, project: dict, data_source: dict):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "sql",
                "name": "dau",
                "display_name": "Daily Active Users",
                "data_source_id": data_source["id"],
                "interval": "1d",
                "config": {
                    "metric_sql": "SELECT toDate(t) AS bucket, count() AS v FROM e GROUP BY bucket",
                    "time_column": "t",
                },
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["kind"] == "sql"
        assert data["config"]["metric_sql"].startswith("SELECT")
        assert data["data_source_id"] == data_source["id"]

    async def test_create_event_composition_single(
        self, client: AsyncClient, project: dict, event: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "event_composition",
                "name": "signup_count",
                "display_name": "Signups",
                "composition": "single",
                "numerator_event_id": event["id"],
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["kind"] == "event_composition"
        assert data["composition"] == "single"
        assert data["numerator_event_id"] == event["id"]
        # Composition metrics read existing series: no data source / interval.
        assert data["data_source_id"] is None
        assert data["interval"] is None

    async def test_create_event_composition_ratio(
        self, client: AsyncClient, project: dict, event: dict, event_type: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "event_composition",
                "name": "conversion",
                "display_name": "Conversion",
                "composition": "ratio",
                "numerator_event_id": event["id"],
                "denominator_event_type_id": event_type["id"],
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["composition"] == "ratio"
        assert data["numerator_event_id"] == event["id"]
        assert data["denominator_event_type_id"] == event_type["id"]


class TestListFilterPagination:
    async def _seed(self, client: AsyncClient, slug: str, data_source_id: str) -> None:
        for idx in range(3):
            resp = await client.post(
                _metrics_url(slug),
                json={
                    "kind": "sql",
                    "name": f"m{idx}",
                    "display_name": f"Metric {idx}",
                    "data_source_id": data_source_id,
                    "interval": "1d",
                    "config": {"metric_sql": "SELECT 1 AS v, now() AS t", "time_column": "t"},
                },
            )
            assert resp.status_code == 201, resp.text

    async def test_list_returns_items_and_total(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        await self._seed(client, project["slug"], data_source["id"])
        resp = await client.get(_metrics_url(project["slug"]))
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 3
        assert len(body["items"]) == 3

    async def test_list_filter_by_kind(
        self, client: AsyncClient, project: dict, data_source: dict, event: dict
    ):
        await self._seed(client, project["slug"], data_source["id"])
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "event_composition",
                "name": "comp",
                "display_name": "Comp",
                "composition": "single",
                "numerator_event_id": event["id"],
            },
        )
        assert resp.status_code == 201
        resp = await client.get(_metrics_url(project["slug"]), params={"kind": "sql"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 3
        assert all(item["kind"] == "sql" for item in body["items"])

    async def test_list_search_and_pagination(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        await self._seed(client, project["slug"], data_source["id"])
        resp = await client.get(_metrics_url(project["slug"]), params={"search": "m1"})
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

        resp = await client.get(_metrics_url(project["slug"]), params={"offset": 0, "limit": 2})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 3
        assert len(body["items"]) == 2


class TestNameUniqueness:
    async def test_duplicate_name_conflict(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        payload = {
            "kind": "sql",
            "name": "dup",
            "display_name": "Dup",
            "data_source_id": data_source["id"],
            "interval": "1d",
            "config": {"metric_sql": "SELECT 1 AS v, now() AS t", "time_column": "t"},
        }
        first = await client.post(_metrics_url(project["slug"]), json=payload)
        assert first.status_code == 201
        second = await client.post(_metrics_url(project["slug"]), json=payload)
        assert second.status_code == 409


class TestConfigValidation:
    async def test_fact_single_sum_without_measure_column(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "bad_sum",
                "display_name": "Bad Sum",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "sum",
                "interval": "1h",
            },
        )
        assert resp.status_code == 422

    async def test_fact_single_count_distinct_requires_distinct_column(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "bad_cd",
                "display_name": "Bad CD",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count_distinct",
                "interval": "1h",
            },
        )
        assert resp.status_code == 422

    async def test_fact_single_without_fact_table_id(
        self, client: AsyncClient, project: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "no_ft",
                "display_name": "No Fact Table",
                "composition": "single",
                "aggregation": "count",
                "interval": "1h",
            },
        )
        assert resp.status_code == 422

    async def test_fact_measure_column_not_in_fact_table_rejected(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        # A syntactically valid identifier that is NOT one of the fact table's
        # introspected columns is rejected by the service-level allowlist check.
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "ghost_col",
                "display_name": "Ghost Col",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "sum",
                "interval": "1h",
                "measure_column": "not_a_column",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_fact_unknown_row_filter_rejected(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "ghost_filter",
                "display_name": "Ghost Filter",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count",
                "interval": "1h",
                "row_filter": "does_not_exist",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_fact_unknown_row_filters_entry_rejected(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        # One known name + one unknown name in ``row_filters`` -> 422 (same as the
        # legacy single ``row_filter`` unknown-name rejection).
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "ghost_in_list",
                "display_name": "Ghost in list",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count",
                "interval": "1h",
                "row_filters": ["exclude_test", "does_not_exist"],
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_fact_nonexistent_fact_table_rejected(
        self, client: AsyncClient, project: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "ghost_ft",
                "display_name": "Ghost FT",
                "composition": "single",
                "fact_table_id": str(uuid.uuid4()),
                "aggregation": "count",
                "interval": "1h",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_sql_without_metric_sql(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "sql",
                "name": "no_sql",
                "display_name": "No SQL",
                "data_source_id": data_source["id"],
                "interval": "1d",
                "config": {"time_column": "t"},
            },
        )
        assert resp.status_code == 422

    async def test_sql_without_data_source(self, client: AsyncClient, project: dict):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "sql",
                "name": "no_ds",
                "display_name": "No DS",
                "interval": "1d",
                "config": {"metric_sql": "SELECT 1 AS v, now() AS t", "time_column": "t"},
            },
        )
        assert resp.status_code == 422

    async def test_event_composition_ratio_without_denominator(
        self, client: AsyncClient, project: dict, event: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "event_composition",
                "name": "ratio_no_denom",
                "display_name": "Ratio No Denominator",
                "composition": "ratio",
                "numerator_event_id": event["id"],
            },
        )
        assert resp.status_code == 422

    async def test_event_composition_with_nonexistent_event(
        self, client: AsyncClient, project: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "event_composition",
                "name": "ghost_ref",
                "display_name": "Ghost Ref",
                "composition": "single",
                "numerator_event_id": str(uuid.uuid4()),
            },
        )
        assert resp.status_code == 422


class TestUpdateDeleteReorder:
    async def _create_sql(
        self, client: AsyncClient, slug: str, data_source_id: str, name: str
    ) -> dict:
        resp = await client.post(
            _metrics_url(slug),
            json={
                "kind": "sql",
                "name": name,
                "display_name": name.upper(),
                "data_source_id": data_source_id,
                "interval": "1d",
                "config": {"metric_sql": "SELECT 1 AS v, now() AS t", "time_column": "t"},
            },
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    async def test_update_metric(self, client: AsyncClient, project: dict, data_source: dict):
        metric = await self._create_sql(client, project["slug"], data_source["id"], "upd")
        resp = await client.patch(
            f"{_metrics_url(project['slug'])}/{metric['id']}",
            json={"display_name": "Updated", "status": "active", "reviewed": True},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["display_name"] == "Updated"
        assert data["status"] == "active"
        assert data["reviewed"] is True

    async def test_delete_metric(self, client: AsyncClient, project: dict, data_source: dict):
        metric = await self._create_sql(client, project["slug"], data_source["id"], "del")
        resp = await client.delete(f"{_metrics_url(project['slug'])}/{metric['id']}")
        assert resp.status_code == 204
        resp = await client.get(f"{_metrics_url(project['slug'])}/{metric['id']}")
        assert resp.status_code == 404

    async def test_bulk_update_status(self, client: AsyncClient, project: dict, data_source: dict):
        m1 = await self._create_sql(client, project["slug"], data_source["id"], "b1")
        m2 = await self._create_sql(client, project["slug"], data_source["id"], "b2")
        resp = await client.post(
            f"{_metrics_url(project['slug'])}/bulk-update",
            json={"metric_ids": [m1["id"], m2["id"]], "status": "archived"},
        )
        assert resp.status_code == 204
        listing = await client.get(_metrics_url(project["slug"]), params={"status": "archived"})
        assert listing.json()["total"] == 2

    async def test_reorder_metrics(self, client: AsyncClient, project: dict, data_source: dict):
        m1 = await self._create_sql(client, project["slug"], data_source["id"], "r1")
        m2 = await self._create_sql(client, project["slug"], data_source["id"], "r2")
        resp = await client.patch(
            f"{_metrics_url(project['slug'])}/reorder",
            json={"metric_ids": [m2["id"], m1["id"]]},
        )
        assert resp.status_code == 200, resp.text
        ordered = resp.json()
        assert [item["id"] for item in ordered] == [m2["id"], m1["id"]]
        assert ordered[0]["order"] <= ordered[1]["order"]


class TestSchemaSecurityValidation:
    """The schema boundary is the only gate before warehouse SQL with no bound
    params, so every identifier / SQL-text field must reject injection probes."""

    async def test_reject_row_filter_raw_sql_fragment(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        # ``row_filter`` is the NAME of a stored fact-table filter, never a raw
        # SQL fragment: a fragment is not a known name and is rejected.
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "inj_filter_name",
                "display_name": "Inj Filter Name",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count",
                "interval": "1h",
                "row_filter": "1=1 UNION SELECT secret FROM users --",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_filter_sql_injection(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        # ``filter_sql`` is free-text but SQL-safety-validated at the schema
        # boundary (same guard as a fact table's named row filter): a stacked
        # statement / UNION / comment probe is rejected.
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "inj_filter_sql",
                "display_name": "Inj Filter SQL",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count",
                "interval": "1h",
                "filter_sql": "1=1; DROP TABLE users --",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_empty_filter_sql(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "empty_filter_sql",
                "display_name": "Empty Filter SQL",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "count",
                "interval": "1h",
                "filter_sql": "   ",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_measure_column_with_quote(
        self, client: AsyncClient, project: dict, fact_table: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact",
                "name": "inj_measure",
                "display_name": "Inj Measure",
                "composition": "single",
                "fact_table_id": fact_table["id"],
                "aggregation": "sum",
                "interval": "1h",
                "measure_column": "am'ount",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_breakdown_column_bad_identifier(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "sql",
                "name": "inj_breakdown",
                "display_name": "Inj Breakdown",
                "data_source_id": data_source["id"],
                "interval": "1d",
                "config": {"metric_sql": "SELECT 1 AS v, now() AS t", "time_column": "t"},
                "breakdown_columns": ["good_col", "bad-col"],
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_app_version_column_bad(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "sql",
                "name": "inj_appver",
                "display_name": "Inj AppVer",
                "data_source_id": data_source["id"],
                "interval": "1d",
                "config": {"metric_sql": "SELECT 1 AS v, now() AS t", "time_column": "t"},
                "app_version_column": "app version",
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_metric_sql_with_drop_and_comment(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "sql",
                "name": "inj_sql",
                "display_name": "Inj SQL",
                "data_source_id": data_source["id"],
                "interval": "1d",
                "config": {
                    "metric_sql": "SELECT 1 AS v FROM x; DROP TABLE y -- gone",
                    "time_column": "t",
                },
            },
        )
        assert resp.status_code == 422, resp.text

class TestBulkUpdateOwner:
    async def test_owner_id_null_unassigns_owner(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        owner_id = (await client.get("/api/v1/users")).json()[0]["id"]
        metric = await _create_sql_metric(client, project["slug"], data_source["id"], "owned")

        assign = await client.post(
            f"{_metrics_url(project['slug'])}/bulk-update",
            json={"metric_ids": [metric["id"]], "owner_id": owner_id},
        )
        assert assign.status_code == 204
        got = await client.get(f"{_metrics_url(project['slug'])}/{metric['id']}")
        assert got.json()["owner_id"] == owner_id

        unassign = await client.post(
            f"{_metrics_url(project['slug'])}/bulk-update",
            json={"metric_ids": [metric["id"]], "owner_id": None},
        )
        assert unassign.status_code == 204
        got = await client.get(f"{_metrics_url(project['slug'])}/{metric['id']}")
        assert got.json()["owner_id"] is None

    async def test_bulk_update_without_any_field_is_422(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        metric = await _create_sql_metric(client, project["slug"], data_source["id"], "nofield")
        resp = await client.post(
            f"{_metrics_url(project['slug'])}/bulk-update",
            json={"metric_ids": [metric["id"]]},
        )
        assert resp.status_code == 422, resp.text


class TestListEnumValidation:
    async def test_invalid_kind_returns_422(self, client: AsyncClient, project: dict):
        resp = await client.get(_metrics_url(project["slug"]), params={"kind": "bogus"})
        assert resp.status_code == 422, resp.text

    async def test_invalid_status_returns_422(self, client: AsyncClient, project: dict):
        resp = await client.get(_metrics_url(project["slug"]), params={"status": "bogus"})
        assert resp.status_code == 422, resp.text


class TestMoveMetric:
    async def test_move_up_swaps_with_previous(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        m0 = await _create_sql_metric(client, slug, data_source["id"], "mv_up0", order=0)
        m1 = await _create_sql_metric(client, slug, data_source["id"], "mv_up1", order=1)

        resp = await client.patch(f"{_metrics_url(slug)}/{m1['id']}/move", json={"direction": "up"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["order"] == 0

        other = await client.get(f"{_metrics_url(slug)}/{m0['id']}")
        assert other.json()["order"] == 1

    async def test_move_down_swaps_with_next(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        m0 = await _create_sql_metric(client, slug, data_source["id"], "mv_dn0", order=0)
        m1 = await _create_sql_metric(client, slug, data_source["id"], "mv_dn1", order=1)

        resp = await client.patch(
            f"{_metrics_url(slug)}/{m0['id']}/move", json={"direction": "down"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["order"] == 1

        other = await client.get(f"{_metrics_url(slug)}/{m1['id']}")
        assert other.json()["order"] == 0

    async def test_move_up_when_first_is_noop(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        slug = project["slug"]
        m0 = await _create_sql_metric(client, slug, data_source["id"], "mv_first0", order=0)
        await _create_sql_metric(client, slug, data_source["id"], "mv_first1", order=1)

        resp = await client.patch(f"{_metrics_url(slug)}/{m0['id']}/move", json={"direction": "up"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["order"] == 0


class TestCrossProjectIsolation:
    async def test_metric_from_other_project_returns_404(
        self, client: AsyncClient, data_source: dict
    ):
        proj_a = await client.post(
            "/api/v1/projects",
            json={"name": "Proj A", "slug": "proj-a", "description": ""},
        )
        proj_b = await client.post(
            "/api/v1/projects",
            json={"name": "Proj B", "slug": "proj-b", "description": ""},
        )
        assert proj_a.status_code == 201
        assert proj_b.status_code == 201

        metric_b = await _create_sql_metric(client, "proj-b", data_source["id"], "b_metric")

        # A valid metric_id from project B, fetched under project A's slug, must 404.
        resp = await client.get(f"/api/v1/projects/proj-a/metrics/{metric_b['id']}")
        assert resp.status_code == 404, resp.text
