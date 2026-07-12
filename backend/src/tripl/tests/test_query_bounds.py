"""Bounds checks for unbounded numeric query params and list limits.

Each representative endpoint must reject an over-ceiling value with HTTP 422
(FastAPI validation) and accept an in-range value. The point is the validation
boundary, not the response payload, so the in-range cases only assert a
non-422 success-ish status.
"""

import pytest
from httpx import AsyncClient


async def _create_project(client: AsyncClient, slug: str) -> None:
    resp = await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_kpi_series_days_over_ceiling_rejected(client: AsyncClient):
    await _create_project(client, "bounds-kpi")
    resp = await client.get("/api/v1/projects/bounds-kpi/overview/kpi-series?days=99999")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_kpi_series_days_in_range_ok(client: AsyncClient):
    await _create_project(client, "bounds-kpi-ok")
    resp = await client.get("/api/v1/projects/bounds-kpi-ok/overview/kpi-series?days=30")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_top_events_window_hours_over_ceiling_rejected(client: AsyncClient):
    await _create_project(client, "bounds-topwin")
    resp = await client.get("/api/v1/projects/bounds-topwin/overview/top-events?window_hours=99999")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_top_events_limit_over_ceiling_rejected(client: AsyncClient):
    await _create_project(client, "bounds-toplim")
    resp = await client.get("/api/v1/projects/bounds-toplim/overview/top-events?limit=999999")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_top_events_in_range_ok(client: AsyncClient):
    await _create_project(client, "bounds-top-ok")
    resp = await client.get(
        "/api/v1/projects/bounds-top-ok/overview/top-events?window_hours=24&limit=5"
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_data_source_stats_window_hours_over_ceiling_rejected(client: AsyncClient):
    # window_hours is validated before the data source is loaded, so a random
    # id is fine: the 422 fires regardless of whether the source exists.
    resp = await client.get(
        "/api/v1/data-sources/00000000-0000-0000-0000-000000000000/stats?window_hours=99999"
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_events_limit_over_ceiling_rejected(client: AsyncClient):
    await _create_project(client, "bounds-events")
    resp = await client.get("/api/v1/projects/bounds-events/events?limit=999999")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_events_limit_in_range_ok(client: AsyncClient):
    await _create_project(client, "bounds-events-ok")
    resp = await client.get("/api/v1/projects/bounds-events-ok/events?limit=50&offset=0")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_users_limit_over_ceiling_rejected(client: AsyncClient):
    resp = await client.get("/api/v1/users?limit=999999")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_users_offset_negative_rejected(client: AsyncClient):
    resp = await client.get("/api/v1/users?offset=-1")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_users_pagination_in_range_ok(client: AsyncClient):
    resp = await client.get("/api/v1/users?limit=50&offset=0")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
