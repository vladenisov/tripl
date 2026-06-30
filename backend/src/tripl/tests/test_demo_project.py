"""Tests for the demo project generator endpoint."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_create_demo_project_returns_201(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    data = resp.json()
    assert data["slug"].startswith("demo-")
    assert len(data["slug"]) == len("demo-") + 6


@pytest.mark.asyncio
async def test_demo_project_has_events(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    events_resp = await client.get(f"/api/v1/projects/{slug}/events")
    assert events_resp.status_code == 200
    data = events_resp.json()
    items = data["items"] if isinstance(data, dict) else data
    assert len(items) > 0

    # At least one event should have field values
    has_field_values = any(len(ev.get("field_values", [])) > 0 for ev in items)
    assert has_field_values, "Expected at least one event with field values"


@pytest.mark.asyncio
async def test_demo_project_has_metrics(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    metrics_resp = await client.get(f"/api/v1/projects/{slug}/metrics/total")
    assert metrics_resp.status_code == 200
    data = metrics_resp.json()
    assert len(data["data"]) > 0, "Expected metric data points for demo project"


@pytest.mark.asyncio
async def test_demo_project_has_metrics_catalog(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    # Metrics catalog: at least the four seeded definitions, covering all kinds.
    metrics_resp = await client.get(f"/api/v1/projects/{slug}/metrics")
    assert metrics_resp.status_code == 200
    metrics = metrics_resp.json()["items"]
    assert len(metrics) >= 4, "Expected at least four seeded metric definitions"
    kinds = {metric["kind"] for metric in metrics}
    assert {"sql", "event_composition", "fact"} <= kinds, kinds

    # MetricValue rows render through the enriched list (latest value + spark).
    with_values = [metric for metric in metrics if metric["spark"]]
    assert with_values, "Expected at least one metric definition with collected values"

    # The conversion ratio is a fraction (purchases / screen views), not a count.
    conversion = next(metric for metric in metrics if metric["name"] == "purchase_conversion")
    assert conversion["kind"] == "event_composition"
    assert conversion["latest_value"] is not None
    assert 0.0 < conversion["latest_value"] < 1.0, conversion["latest_value"]


@pytest.mark.asyncio
async def test_demo_project_has_fact_table_with_named_filter(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    list_resp = await client.get(f"/api/v1/projects/{slug}/fact-tables")
    assert list_resp.status_code == 200
    fact_tables = list_resp.json()["items"]
    assert len(fact_tables) >= 1, "Expected at least one seeded fact table"

    fact_table_id = fact_tables[0]["id"]
    detail_resp = await client.get(f"/api/v1/projects/{slug}/fact-tables/{fact_table_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    filter_names = {row_filter["name"] for row_filter in detail["row_filters"]}
    assert "completed" in filter_names, filter_names


@pytest.mark.asyncio
async def test_create_demo_project_twice_unique_slugs(client: AsyncClient) -> None:
    resp1 = await client.post("/api/v1/projects/demo")
    resp2 = await client.post("/api/v1/projects/demo")
    assert resp1.status_code == 201
    assert resp2.status_code == 201
    assert resp1.json()["slug"] != resp2.json()["slug"]


@pytest.mark.asyncio
async def test_demo_project_viewer_cannot_create(anon_client: AsyncClient) -> None:
    # Register a new user (default role is viewer in a fresh instance with
    # an existing owner, but in tests the first registered user becomes owner
    # and subsequent ones are viewers).  Here we use anon_client which has no
    # session at all — the endpoint should return 401.
    resp = await anon_client.post("/api/v1/projects/demo")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_delete_demo_project_cascades(client: AsyncClient) -> None:
    # A demo project is data-rich (event types, events, fields, metrics,
    # signals, drifts, scan configs). Deleting it must succeed and remove it.
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    slug = resp.json()["slug"]

    del_resp = await client.delete(f"/api/v1/projects/{slug}")
    assert del_resp.status_code == 204
    assert (await client.get(f"/api/v1/projects/{slug}")).status_code == 404
