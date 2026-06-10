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
    has_field_values = any(
        len(ev.get("field_values", [])) > 0 for ev in items
    )
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
