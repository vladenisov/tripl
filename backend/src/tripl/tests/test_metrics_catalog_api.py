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


class TestCreateHappyPaths:
    async def test_create_fact_aggregation_sum(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "revenue",
                "display_name": "Revenue",
                "aggregation": "sum",
                "data_source_id": data_source["id"],
                "interval": "1h",
                "config": {
                    "source_table": "orders",
                    "measure_column": "amount",
                    "time_column": "created_at",
                },
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["kind"] == "fact_aggregation"
        assert data["aggregation"] == "sum"
        assert data["composition"] is None
        assert data["data_source_id"] == data_source["id"]
        assert data["interval"] == "1h"
        assert data["config"]["measure_column"] == "amount"
        assert data["status"] == "draft"
        assert data["project_id"] == project["id"]

    async def test_create_fact_aggregation_count_without_measure(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "orders_count",
                "display_name": "Orders",
                "aggregation": "count",
                "data_source_id": data_source["id"],
                "interval": "1d",
                "config": {"source_table": "orders"},
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["config"].get("measure_column") is None

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
    async def test_fact_aggregation_sum_without_measure_column(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "bad_sum",
                "display_name": "Bad Sum",
                "aggregation": "sum",
                "data_source_id": data_source["id"],
                "interval": "1h",
                "config": {"source_table": "orders", "time_column": "created_at"},
            },
        )
        assert resp.status_code == 422

    async def test_fact_aggregation_without_source(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "no_source",
                "display_name": "No Source",
                "aggregation": "count",
                "data_source_id": data_source["id"],
                "interval": "1h",
                "config": {"time_column": "created_at"},
            },
        )
        assert resp.status_code == 422

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

    async def test_reject_source_table_injection(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "inj_table",
                "display_name": "Inj Table",
                "aggregation": "count",
                "data_source_id": data_source["id"],
                "interval": "1h",
                "config": {"source_table": "orders; DROP TABLE x --"},
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_reject_measure_column_with_quote(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "inj_measure",
                "display_name": "Inj Measure",
                "aggregation": "sum",
                "data_source_id": data_source["id"],
                "interval": "1h",
                "config": {"source_table": "orders", "measure_column": "am'ount"},
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

    async def test_reject_filter_sql_union(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "inj_filter",
                "display_name": "Inj Filter",
                "aggregation": "count",
                "data_source_id": data_source["id"],
                "interval": "1h",
                "config": {
                    "source_table": "orders",
                    "filter_sql": "1=1 UNION SELECT secret FROM users --",
                },
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

    async def test_reject_base_query_forbidden_keyword(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "inj_base",
                "display_name": "Inj Base",
                "aggregation": "count",
                "data_source_id": data_source["id"],
                "interval": "1h",
                "config": {"base_query": "SELECT * FROM users UNION SELECT secret FROM admin"},
            },
        )
        assert resp.status_code == 422, resp.text

    async def test_accept_clean_fact_aggregation_with_filter_sql(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        resp = await client.post(
            _metrics_url(project["slug"]),
            json={
                "kind": "fact_aggregation",
                "name": "clean_filter",
                "display_name": "Clean Filter",
                "aggregation": "sum",
                "data_source_id": data_source["id"],
                "interval": "1h",
                "config": {
                    "source_table": "orders",
                    "measure_column": "amount",
                    "time_column": "created_at",
                    "filter_sql": "is_test = 0 AND country IN ('US','GB')",
                },
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["config"]["filter_sql"] == "is_test = 0 AND country IN ('US','GB')"


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
