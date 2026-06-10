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
async def test_field_contract_rules_round_trip(client: AsyncClient):
    et_id = await _setup(client, "f-contract")
    create = await client.post(
        f"/api/v1/projects/f-contract/event-types/{et_id}/fields",
        json={
            "name": "amount",
            "display_name": "Amount",
            "field_type": "number",
            "is_required": True,
            "contract_required_max_null_rate": 0.02,
            "contract_min_value": 0,
            "contract_max_value": 100,
            "contract_max_bad_rate": 0.01,
        },
    )
    assert create.status_code == 201
    body = create.json()
    field_id = body["id"]
    assert body["contract_required_max_null_rate"] == 0.02
    assert body["contract_min_value"] == 0
    assert body["contract_max_value"] == 100
    assert body["contract_max_bad_rate"] == 0.01

    update = await client.patch(
        f"/api/v1/projects/f-contract/event-types/{et_id}/fields/{field_id}",
        json={
            "contract_regex": r"^\d+(\.\d+)?$",
            "contract_min_value": None,
            "contract_max_bad_rate": 0.05,
        },
    )
    assert update.status_code == 200
    updated = update.json()
    assert updated["contract_regex"] == r"^\d+(\.\d+)?$"
    assert updated["contract_min_value"] is None
    assert updated["contract_max_bad_rate"] == 0.05

    bad_rate = await client.post(
        f"/api/v1/projects/f-contract/event-types/{et_id}/fields",
        json={
            "name": "bad_rate",
            "display_name": "Bad rate",
            "field_type": "string",
            "contract_max_bad_rate": 1.2,
        },
    )
    assert bad_rate.status_code == 422

    bad_regex = await client.post(
        f"/api/v1/projects/f-contract/event-types/{et_id}/fields",
        json={
            "name": "bad_regex",
            "display_name": "Bad regex",
            "field_type": "string",
            "contract_regex": "[",
        },
    )
    assert bad_regex.status_code == 422


@pytest.mark.asyncio
async def test_create_event_type_with_fields(client: AsyncClient):
    await client.post("/api/v1/projects", json={"name": "ETF", "slug": "etf-proj"})
    resp = await client.post(
        "/api/v1/projects/etf-proj/event-types",
        json={
            "name": "old",
            "display_name": "Old events",
            "field_definitions": [
                {"name": "event_name", "display_name": "Event name", "field_type": "string"},
                {"name": "event_property", "display_name": "Property", "field_type": "json"},
            ],
        },
    )
    assert resp.status_code == 201
    fields = resp.json()["field_definitions"]
    assert [f["name"] for f in fields] == ["event_name", "event_property"]
    assert [f["order"] for f in fields] == [0, 1]


@pytest.mark.asyncio
async def test_bulk_create_fields_skips_existing(client: AsyncClient):
    et_id = await _setup(client, "f-bulk")
    await client.post(
        f"/api/v1/projects/f-bulk/event-types/{et_id}/fields",
        json={"name": "event_name", "display_name": "Event name", "field_type": "string"},
    )
    resp = await client.post(
        f"/api/v1/projects/f-bulk/event-types/{et_id}/fields/bulk",
        json={
            "fields": [
                {"name": "event_name", "display_name": "dup", "field_type": "string"},
                {"name": "event_property", "display_name": "event_property", "field_type": "json"},
            ]
        },
    )
    assert resp.status_code == 201
    names = [f["name"] for f in resp.json()]
    assert names == ["event_name", "event_property"]
    # Existing field was not duplicated or overwritten.
    assert sum(1 for n in names if n == "event_name") == 1


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
