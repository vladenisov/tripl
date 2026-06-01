"""CRUD + scope filtering for chart annotations."""

import pytest
from httpx import AsyncClient


async def _setup_project(client: AsyncClient, slug: str = "ann-proj") -> str:
    await client.post("/api/v1/projects", json={"name": "P", "slug": slug})
    return slug


@pytest.mark.asyncio
async def test_create_and_list_project_wide_annotation(client: AsyncClient) -> None:
    slug = await _setup_project(client)

    resp = await client.post(
        f"/api/v1/projects/{slug}/annotations",
        json={
            "bucket": "2026-05-01T10:00:00Z",
            "label": "v1.4 deploy",
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["label"] == "v1.4 deploy"
    assert body["scope_type"] is None
    assert body["color"] == "#ef4444"

    listed = await client.get(f"/api/v1/projects/{slug}/annotations")
    assert listed.status_code == 200
    assert len(listed.json()) == 1


@pytest.mark.asyncio
async def test_scope_filter_includes_project_wide_and_matching_scope(
    client: AsyncClient,
) -> None:
    slug = await _setup_project(client, slug="ann-scope")

    await client.post(
        f"/api/v1/projects/{slug}/annotations",
        json={"bucket": "2026-05-01T10:00:00Z", "label": "global"},
    )
    await client.post(
        f"/api/v1/projects/{slug}/annotations",
        json={
            "bucket": "2026-05-02T10:00:00Z",
            "label": "scoped",
            "scope_type": "event_type",
            "scope_ref": "00000000-0000-0000-0000-000000000001",
        },
    )
    await client.post(
        f"/api/v1/projects/{slug}/annotations",
        json={
            "bucket": "2026-05-03T10:00:00Z",
            "label": "other-scope",
            "scope_type": "event_type",
            "scope_ref": "00000000-0000-0000-0000-000000000002",
        },
    )

    resp = await client.get(
        f"/api/v1/projects/{slug}/annotations",
        params={
            "scope_type": "event_type",
            "scope_ref": "00000000-0000-0000-0000-000000000001",
        },
    )
    assert resp.status_code == 200
    labels = sorted(item["label"] for item in resp.json())
    assert labels == ["global", "scoped"]


@pytest.mark.asyncio
async def test_partial_scope_is_rejected(client: AsyncClient) -> None:
    slug = await _setup_project(client, slug="ann-partial")

    resp = await client.post(
        f"/api/v1/projects/{slug}/annotations",
        json={
            "bucket": "2026-05-01T10:00:00Z",
            "label": "bad",
            "scope_type": "event_type",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_delete_annotation_removes_it(client: AsyncClient) -> None:
    slug = await _setup_project(client, slug="ann-del")

    create = await client.post(
        f"/api/v1/projects/{slug}/annotations",
        json={"bucket": "2026-05-01T10:00:00Z", "label": "to delete"},
    )
    annotation_id = create.json()["id"]

    deleted = await client.delete(f"/api/v1/projects/{slug}/annotations/{annotation_id}")
    assert deleted.status_code == 204

    listed = await client.get(f"/api/v1/projects/{slug}/annotations")
    assert listed.json() == []
