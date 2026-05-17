import pytest
from httpx import AsyncClient


async def _setup(client: AsyncClient, slug: str = "f-proj"):
    await client.post("/api/v1/projects", json={"name": "F", "slug": slug})
    resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "PV"},
    )
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_create_field(client: AsyncClient):
    et_id = await _setup(client)
    resp = await client.post(
        f"/api/v1/projects/f-proj/event-types/{et_id}/fields",
        json={
            "name": "screen",
            "display_name": "Screen",
            "field_type": "string",
            "is_required": True,
        },
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "screen"
    assert resp.json()["is_required"] is True


@pytest.mark.asyncio
async def test_create_field_duplicate(client: AsyncClient):
    et_id = await _setup(client, "f-dup")
    await client.post(
        f"/api/v1/projects/f-dup/event-types/{et_id}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    resp = await client.post(
        f"/api/v1/projects/f-dup/event-types/{et_id}/fields",
        json={"name": "screen", "display_name": "Screen2", "field_type": "string"},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_list_fields(client: AsyncClient):
    et_id = await _setup(client, "f-list")
    await client.post(
        f"/api/v1/projects/f-list/event-types/{et_id}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    await client.post(
        f"/api/v1/projects/f-list/event-types/{et_id}/fields",
        json={"name": "data", "display_name": "Data", "field_type": "json"},
    )
    resp = await client.get(f"/api/v1/projects/f-list/event-types/{et_id}/fields")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


@pytest.mark.asyncio
async def test_update_field(client: AsyncClient):
    et_id = await _setup(client, "f-upd")
    create = await client.post(
        f"/api/v1/projects/f-upd/event-types/{et_id}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    field_id = create.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/f-upd/event-types/{et_id}/fields/{field_id}",
        json={"display_name": "Screen Name"},
    )
    assert resp.status_code == 200
    assert resp.json()["display_name"] == "Screen Name"


@pytest.mark.asyncio
async def test_delete_field(client: AsyncClient):
    et_id = await _setup(client, "f-del")
    create = await client.post(
        f"/api/v1/projects/f-del/event-types/{et_id}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    field_id = create.json()["id"]
    resp = await client.delete(f"/api/v1/projects/f-del/event-types/{et_id}/fields/{field_id}")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_field_sensitivity_round_trip(client: AsyncClient):
    et_id = await _setup(client, "f-sens")
    create = await client.post(
        f"/api/v1/projects/f-sens/event-types/{et_id}/fields",
        json={
            "name": "email",
            "display_name": "Email",
            "field_type": "string",
            "sensitivity": "pii",
        },
    )
    assert create.status_code == 201
    field_id = create.json()["id"]
    assert create.json()["sensitivity"] == "pii"

    # Default is "none" when sensitivity is omitted.
    other = await client.post(
        f"/api/v1/projects/f-sens/event-types/{et_id}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    assert other.json()["sensitivity"] == "none"

    # Invalid value is rejected.
    bad = await client.post(
        f"/api/v1/projects/f-sens/event-types/{et_id}/fields",
        json={
            "name": "bogus",
            "display_name": "Bogus",
            "field_type": "string",
            "sensitivity": "top-secret",
        },
    )
    assert bad.status_code == 422

    # PATCH updates sensitivity in place.
    upd = await client.patch(
        f"/api/v1/projects/f-sens/event-types/{et_id}/fields/{field_id}",
        json={"sensitivity": "secret"},
    )
    assert upd.status_code == 200
    assert upd.json()["sensitivity"] == "secret"


@pytest.mark.asyncio
async def test_reorder_fields(client: AsyncClient):
    et_id = await _setup(client, "f-reorder")
    r1 = await client.post(
        f"/api/v1/projects/f-reorder/event-types/{et_id}/fields",
        json={"name": "a", "display_name": "A", "field_type": "string", "order": 0},
    )
    r2 = await client.post(
        f"/api/v1/projects/f-reorder/event-types/{et_id}/fields",
        json={"name": "b", "display_name": "B", "field_type": "string", "order": 1},
    )
    id_a = r1.json()["id"]
    id_b = r2.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/f-reorder/event-types/{et_id}/fields/reorder",
        json={"field_ids": [id_b, id_a]},
    )
    assert resp.status_code == 200
    fields = resp.json()
    assert fields[0]["name"] == "b"
    assert fields[1]["name"] == "a"
