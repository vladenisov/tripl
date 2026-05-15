import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from tripl.models.event import Event
from tripl.tests.conftest import TestSessionLocal


async def _setup_events(client: AsyncClient, slug: str = "ev-proj"):
    await client.post("/api/v1/projects", json={"name": "E", "slug": slug})
    et_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    et_id = et_resp.json()["id"]
    f_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={
            "name": "screen",
            "display_name": "Screen",
            "field_type": "string",
            "is_required": True,
        },
    )
    field_id = f_resp.json()["id"]
    await client.post(
        f"/api/v1/projects/{slug}/meta-fields",
        json={"name": "jira", "display_name": "Jira", "field_type": "url"},
    )
    meta_resp = await client.get(f"/api/v1/projects/{slug}/meta-fields")
    meta_id = meta_resp.json()[0]["id"]
    return et_id, field_id, meta_id


@pytest.mark.asyncio
async def test_create_event(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client)
    resp = await client.post(
        "/api/v1/projects/ev-proj/events",
        json={
            "event_type_id": et_id,
            "name": "Home Page View",
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
            "meta_values": [
                {"meta_field_definition_id": meta_id, "value": "https://jira.example.com/TICK-1"}
            ],
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Home Page View"
    assert data["order"] == 0
    assert len(data["field_values"]) == 1
    assert len(data["meta_values"]) == 1


@pytest.mark.asyncio
async def test_create_event_missing_required_field(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client, "ev-req")
    resp = await client.post(
        "/api/v1/projects/ev-req/events",
        json={
            "event_type_id": et_id,
            "name": "No Screen",
            "field_values": [],
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_list_events(client: AsyncClient):
    et_id, field_id, meta_id = await _setup_events(client, "ev-list")
    await client.post(
        "/api/v1/projects/ev-list/events",
        json={
            "event_type_id": et_id,
            "name": "Event 1",
            "field_values": [{"field_definition_id": field_id, "value": "screen1"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-list/events",
        json={
            "event_type_id": et_id,
            "name": "Event 2",
            "field_values": [{"field_definition_id": field_id, "value": "screen2"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-list/events")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    assert [item["order"] for item in data["items"]] == [0, 1]


@pytest.mark.asyncio
async def test_list_events_search(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-search")
    await client.post(
        "/api/v1/projects/ev-search/events",
        json={
            "event_type_id": et_id,
            "name": "Alpha Page",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-search/events",
        json={
            "event_type_id": et_id,
            "name": "Beta Click",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-search/events?search=Alpha")
    assert resp.json()["total"] == 1


@pytest.mark.asyncio
async def test_update_event(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-upd")
    create = await client.post(
        "/api/v1/projects/ev-upd/events",
        json={
            "event_type_id": et_id,
            "name": "Old Name",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    event_id = create.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/ev-upd/events/{event_id}",
        json={"name": "New Name"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"


@pytest.mark.asyncio
async def test_delete_event(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-del")
    create = await client.post(
        "/api/v1/projects/ev-del/events",
        json={
            "event_type_id": et_id,
            "name": "To Delete",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    event_id = create.json()["id"]
    resp = await client.delete(f"/api/v1/projects/ev-del/events/{event_id}")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_bulk_delete_events(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-bulk-del")
    first = await client.post(
        "/api/v1/projects/ev-bulk-del/events",
        json={
            "event_type_id": et_id,
            "name": "First",
            "field_values": [{"field_definition_id": field_id, "value": "a"}],
        },
    )
    second = await client.post(
        "/api/v1/projects/ev-bulk-del/events",
        json={
            "event_type_id": et_id,
            "name": "Second",
            "field_values": [{"field_definition_id": field_id, "value": "b"}],
        },
    )

    resp = await client.post(
        "/api/v1/projects/ev-bulk-del/events/bulk-delete",
        json={"event_ids": [first.json()["id"], second.json()["id"]]},
    )
    assert resp.status_code == 204

    list_resp = await client.get("/api/v1/projects/ev-bulk-del/events")
    assert list_resp.status_code == 200
    assert list_resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_create_event_with_tags_and_implemented(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-tags")
    resp = await client.post(
        "/api/v1/projects/ev-tags/events",
        json={
            "event_type_id": et_id,
            "name": "Tagged Event",
            "implemented": True,
            "tags": ["mobile", "v2"],
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["implemented"] is True
    assert sorted([t["name"] for t in data["tags"]]) == ["mobile", "v2"]


@pytest.mark.asyncio
async def test_filter_by_implemented(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-impl")
    await client.post(
        "/api/v1/projects/ev-impl/events",
        json={
            "event_type_id": et_id,
            "name": "Done",
            "implemented": True,
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-impl/events",
        json={
            "event_type_id": et_id,
            "name": "Not Done",
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-impl/events?implemented=true")
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["name"] == "Done"

    resp = await client.get("/api/v1/projects/ev-impl/events?implemented=false")
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["name"] == "Not Done"


@pytest.mark.asyncio
async def test_filter_by_tag(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-ftag")
    await client.post(
        "/api/v1/projects/ev-ftag/events",
        json={
            "event_type_id": et_id,
            "name": "Mobile Event",
            "tags": ["mobile"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-ftag/events",
        json={
            "event_type_id": et_id,
            "name": "Web Event",
            "tags": ["web"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-ftag/events?tag=mobile")
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["name"] == "Mobile Event"


@pytest.mark.asyncio
async def test_list_tags(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-ltag")
    await client.post(
        "/api/v1/projects/ev-ltag/events",
        json={
            "event_type_id": et_id,
            "name": "E1",
            "tags": ["mobile", "v2"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-ltag/events",
        json={
            "event_type_id": et_id,
            "name": "E2",
            "tags": ["web", "v2"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    resp = await client.get("/api/v1/projects/ev-ltag/events/tags")
    assert resp.status_code == 200
    assert sorted(resp.json()) == ["mobile", "v2", "web"]


@pytest.mark.asyncio
async def test_update_tags_and_implemented(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-utag")
    create = await client.post(
        "/api/v1/projects/ev-utag/events",
        json={
            "event_type_id": et_id,
            "name": "E",
            "tags": ["old"],
            "field_values": [{"field_definition_id": field_id, "value": "s"}],
        },
    )
    event_id = create.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/ev-utag/events/{event_id}",
        json={"implemented": True, "tags": ["new1", "new2"]},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["implemented"] is True
    assert sorted([t["name"] for t in data["tags"]]) == ["new1", "new2"]


@pytest.mark.asyncio
async def test_move_event_reorders_visible_list(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-move")
    created_ids: list[str] = []
    for name in ("Event A", "Event B", "Event C"):
        create = await client.post(
            "/api/v1/projects/ev-move/events",
            json={
                "event_type_id": et_id,
                "name": name,
                "field_values": [{"field_definition_id": field_id, "value": name}],
            },
        )
        created_ids.append(create.json()["id"])

    move_resp = await client.patch(
        f"/api/v1/projects/ev-move/events/{created_ids[2]}/move",
        json={"direction": "up", "visible_event_ids": created_ids},
    )
    assert move_resp.status_code == 200

    list_resp = await client.get("/api/v1/projects/ev-move/events")
    assert list_resp.status_code == 200
    assert [item["name"] for item in list_resp.json()["items"]] == [
        "Event A",
        "Event C",
        "Event B",
    ]


@pytest.mark.asyncio
async def test_reorder_events_assigns_new_sequence(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-reorder")
    created_ids: list[str] = []
    for name in ("Event A", "Event B", "Event C"):
        create = await client.post(
            "/api/v1/projects/ev-reorder/events",
            json={
                "event_type_id": et_id,
                "name": name,
                "field_values": [{"field_definition_id": field_id, "value": name}],
            },
        )
        created_ids.append(create.json()["id"])

    new_sequence = [created_ids[2], created_ids[0], created_ids[1]]
    reorder_resp = await client.patch(
        "/api/v1/projects/ev-reorder/events/reorder",
        json={"event_ids": new_sequence},
    )
    assert reorder_resp.status_code == 200

    list_resp = await client.get("/api/v1/projects/ev-reorder/events")
    assert list_resp.status_code == 200
    assert [item["name"] for item in list_resp.json()["items"]] == [
        "Event C",
        "Event A",
        "Event B",
    ]


@pytest.mark.asyncio
async def test_event_response_carries_null_last_seen_initially(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-lastseen")
    create = await client.post(
        "/api/v1/projects/ev-lastseen/events",
        json={
            "event_type_id": et_id,
            "name": "Hello",
            "field_values": [{"field_definition_id": field_id, "value": "home"}],
        },
    )
    assert create.status_code == 201
    assert create.json()["last_seen_at"] is None

    listed = await client.get("/api/v1/projects/ev-lastseen/events")
    assert listed.status_code == 200
    assert all(item["last_seen_at"] is None for item in listed.json()["items"])


@pytest.mark.asyncio
async def test_filter_silent_since_days(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-silent")
    fresh = await client.post(
        "/api/v1/projects/ev-silent/events",
        json={
            "event_type_id": et_id,
            "name": "Fresh",
            "field_values": [{"field_definition_id": field_id, "value": "s1"}],
        },
    )
    stale = await client.post(
        "/api/v1/projects/ev-silent/events",
        json={
            "event_type_id": et_id,
            "name": "Stale",
            "field_values": [{"field_definition_id": field_id, "value": "s2"}],
        },
    )
    await client.post(
        "/api/v1/projects/ev-silent/events",
        json={
            "event_type_id": et_id,
            "name": "Silent",
            "field_values": [{"field_definition_id": field_id, "value": "s3"}],
        },
    )
    fresh_id = fresh.json()["id"]
    stale_id = stale.json()["id"]

    # Backfill last_seen_at out-of-band — the column is normally written by the
    # metrics pipeline, but the API filter has its own surface that we want to
    # cover here.
    now = datetime.now(UTC)
    async with TestSessionLocal() as session, session.begin():
        fresh_row = await session.get(Event, uuid.UUID(fresh_id))
        stale_row = await session.get(Event, uuid.UUID(stale_id))
        assert fresh_row is not None
        assert stale_row is not None
        fresh_row.last_seen_at = now - timedelta(hours=1)
        stale_row.last_seen_at = now - timedelta(days=10)

    resp = await client.get("/api/v1/projects/ev-silent/events?silent_since_days=7")
    assert resp.status_code == 200
    names = {item["name"] for item in resp.json()["items"]}
    # Stale (10 days ago) and Silent (never) match silent > 7d. Fresh (1h) does not.
    assert names == {"Stale", "Silent"}


@pytest.mark.asyncio
async def test_bulk_create_events(client: AsyncClient):
    et_id, field_id, _ = await _setup_events(client, "ev-bulk")
    resp = await client.post(
        "/api/v1/projects/ev-bulk/events/bulk",
        json=[
            {
                "event_type_id": et_id,
                "name": "Bulk 1",
                "field_values": [{"field_definition_id": field_id, "value": "s1"}],
            },
            {
                "event_type_id": et_id,
                "name": "Bulk 2",
                "field_values": [{"field_definition_id": field_id, "value": "s2"}],
            },
        ],
    )
    assert resp.status_code == 201
    assert len(resp.json()) == 2
