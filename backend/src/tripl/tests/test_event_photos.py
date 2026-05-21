"""Coverage for figma-spec attachments and threaded comments on event_photos.

The existing image upload + URL resolution paths are exercised indirectly via
the wider suite; these tests focus on the new feature surface: figma kind,
URL validation, and the comments thread."""

import pytest
from httpx import AsyncClient


async def _setup_event(client: AsyncClient, slug: str = "ph-proj") -> tuple[str, str]:
    await client.post("/api/v1/projects", json={"name": "P", "slug": slug})
    et_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    et_id = et_resp.json()["id"]
    event_resp = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et_id, "name": "Home Page View"},
    )
    return slug, event_resp.json()["id"]


@pytest.mark.asyncio
async def test_attach_figma_creates_kind_figma_row(client: AsyncClient) -> None:
    slug, event_id = await _setup_event(client)

    resp = await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/figma",
        json={"url": "https://www.figma.com/file/abc123/Onboarding", "title": "Onboarding"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["kind"] == "figma"
    assert body["external_url"] == "https://www.figma.com/file/abc123/Onboarding"
    assert body["url"] == "https://www.figma.com/file/abc123/Onboarding"
    assert body["storage_backend"] is None
    assert body["original_filename"] == "Onboarding"


@pytest.mark.asyncio
async def test_attach_figma_rejects_non_figma_url(client: AsyncClient) -> None:
    slug, event_id = await _setup_event(client, slug="ph-bad")

    resp = await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/figma",
        json={"url": "https://example.com/file/abc", "title": ""},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_list_includes_figma_rows(client: AsyncClient) -> None:
    slug, event_id = await _setup_event(client, slug="ph-list")
    await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/figma",
        json={"url": "https://www.figma.com/proto/xyz/Flow", "title": "Flow"},
    )

    resp = await client.get(f"/api/v1/projects/{slug}/events/{event_id}/photos")
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["kind"] == "figma"


@pytest.mark.asyncio
async def test_delete_figma_row_succeeds(client: AsyncClient) -> None:
    slug, event_id = await _setup_event(client, slug="ph-del")
    create = await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/figma",
        json={"url": "https://www.figma.com/file/del/Spec", "title": ""},
    )
    photo_id = create.json()["id"]

    resp = await client.delete(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/{photo_id}"
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_comments_thread_create_list_reply_delete(client: AsyncClient) -> None:
    slug, event_id = await _setup_event(client, slug="ph-cmt")
    create_photo = await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/figma",
        json={"url": "https://www.figma.com/file/cmt/Spec", "title": ""},
    )
    photo_id = create_photo.json()["id"]

    base = f"/api/v1/projects/{slug}/events/{event_id}/photos/{photo_id}/comments"

    resp = await client.post(base, json={"body": "Top comment"})
    assert resp.status_code == 201
    parent_id = resp.json()["id"]
    assert resp.json()["parent_id"] is None

    reply = await client.post(base, json={"body": "Reply", "parent_id": parent_id})
    assert reply.status_code == 201
    assert reply.json()["parent_id"] == parent_id

    listed = await client.get(base)
    assert listed.status_code == 200
    bodies = [item["body"] for item in listed.json()]
    assert bodies == ["Top comment", "Reply"]

    deleted = await client.delete(f"{base}/{parent_id}")
    assert deleted.status_code == 204
    # Parent comment should be gone. (Postgres cascades the reply via
    # ON DELETE CASCADE; SQLite in tests doesn't enforce FK cascades by
    # default, so we assert on the parent only.)
    after = await client.get(base)
    remaining_ids = {item["id"] for item in after.json()}
    assert parent_id not in remaining_ids


@pytest.mark.asyncio
async def test_comment_parent_must_belong_to_same_photo(client: AsyncClient) -> None:
    slug, event_id = await _setup_event(client, slug="ph-cmt-cross")
    photo_a = await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/figma",
        json={"url": "https://www.figma.com/file/a/A", "title": ""},
    )
    photo_b = await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/figma",
        json={"url": "https://www.figma.com/file/b/B", "title": ""},
    )

    base_a = f"/api/v1/projects/{slug}/events/{event_id}/photos/{photo_a.json()['id']}/comments"
    base_b = f"/api/v1/projects/{slug}/events/{event_id}/photos/{photo_b.json()['id']}/comments"

    top = await client.post(base_a, json={"body": "On A"})
    parent_id = top.json()["id"]

    cross = await client.post(base_b, json={"body": "Wrong parent", "parent_id": parent_id})
    assert cross.status_code == 400
