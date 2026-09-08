import pytest
from httpx import AsyncClient


async def _setup_meta(client: AsyncClient, slug: str = "meta-proj"):
    await client.post("/api/v1/projects", json={"name": "M", "slug": slug})


@pytest.mark.asyncio
async def test_create_meta_field(client: AsyncClient):
    await _setup_meta(client)
    resp = await client.post(
        "/api/v1/projects/meta-proj/meta-fields",
        json={
            "name": "jira_link",
            "display_name": "Jira",
            "field_type": "string",
            "link_template": "https://tracker.example.com/issues/${value}",
        },
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "jira_link"
    assert resp.json()["link_template"] == "https://tracker.example.com/issues/${value}"


@pytest.mark.asyncio
async def test_create_meta_field_duplicate(client: AsyncClient):
    await _setup_meta(client, "meta-dup")
    await client.post(
        "/api/v1/projects/meta-dup/meta-fields",
        json={"name": "status", "display_name": "Status", "field_type": "string"},
    )
    resp = await client.post(
        "/api/v1/projects/meta-dup/meta-fields",
        json={"name": "status", "display_name": "Status2", "field_type": "string"},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_list_meta_fields(client: AsyncClient):
    await _setup_meta(client, "meta-list")
    await client.post(
        "/api/v1/projects/meta-list/meta-fields",
        json={"name": "jira", "display_name": "Jira", "field_type": "url"},
    )
    await client.post(
        "/api/v1/projects/meta-list/meta-fields",
        json={
            "name": "status",
            "display_name": "Status",
            "field_type": "enum",
            "enum_options": ["implemented", "not_implemented"],
        },
    )
    resp = await client.get("/api/v1/projects/meta-list/meta-fields")
    assert resp.status_code == 200
    assert len(resp.json()) == 2


@pytest.mark.asyncio
async def test_update_meta_field(client: AsyncClient):
    await _setup_meta(client, "meta-upd")
    create = await client.post(
        "/api/v1/projects/meta-upd/meta-fields",
        json={"name": "jira", "display_name": "Jira", "field_type": "url"},
    )
    mf_id = create.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/meta-upd/meta-fields/{mf_id}",
        json={
            "display_name": "Jira Link",
            "link_template": "https://tracker.example.com/issues/${value}",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["display_name"] == "Jira Link"
    assert resp.json()["link_template"] == "https://tracker.example.com/issues/${value}"


@pytest.mark.asyncio
async def test_create_meta_field_rejects_invalid_link_template(client: AsyncClient):
    await _setup_meta(client, "meta-invalid-template")
    resp = await client.post(
        "/api/v1/projects/meta-invalid-template/meta-fields",
        json={
            "name": "jira_key",
            "display_name": "Jira Key",
            "field_type": "string",
            "link_template": "https://tracker.example.com/issues/",
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_delete_meta_field(client: AsyncClient):
    await _setup_meta(client, "meta-del")
    create = await client.post(
        "/api/v1/projects/meta-del/meta-fields",
        json={"name": "jira", "display_name": "Jira", "field_type": "url"},
    )
    mf_id = create.json()["id"]
    resp = await client.delete(f"/api/v1/projects/meta-del/meta-fields/{mf_id}")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_allow_multiple_round_trips(client: AsyncClient):
    await _setup_meta(client, "meta-multi")
    create = await client.post(
        "/api/v1/projects/meta-multi/meta-fields",
        json={
            "name": "jira",
            "display_name": "Jira",
            "field_type": "string",
            "allow_multiple": True,
        },
    )
    assert create.status_code == 201
    assert create.json()["allow_multiple"] is True
    mf_id = create.json()["id"]

    listed = await client.get("/api/v1/projects/meta-multi/meta-fields")
    assert listed.json()[0]["allow_multiple"] is True

    off = await client.patch(
        f"/api/v1/projects/meta-multi/meta-fields/{mf_id}",
        json={"allow_multiple": False},
    )
    assert off.status_code == 200
    assert off.json()["allow_multiple"] is False


@pytest.mark.asyncio
async def test_allow_multiple_defaults_off(client: AsyncClient):
    await _setup_meta(client, "meta-multi-default")
    resp = await client.post(
        "/api/v1/projects/meta-multi-default/meta-fields",
        json={"name": "jira", "display_name": "Jira", "field_type": "string"},
    )
    assert resp.status_code == 201
    assert resp.json()["allow_multiple"] is False


@pytest.mark.asyncio
async def test_allow_multiple_rejected_for_boolean_field(client: AsyncClient):
    await _setup_meta(client, "meta-multi-bool")
    resp = await client.post(
        "/api/v1/projects/meta-multi-bool/meta-fields",
        json={
            "name": "shipped",
            "display_name": "Shipped",
            "field_type": "boolean",
            "allow_multiple": True,
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_rejects_multi_when_switching_to_unsupported_type(client: AsyncClient):
    """The pair spans the request and the row, so the schema alone cannot see it.

    `field_type: date` is legal on its own and the stored `allow_multiple` is not
    in the patch — only the service, holding both halves, can refuse it.
    """
    await _setup_meta(client, "meta-multi-switch")
    create = await client.post(
        "/api/v1/projects/meta-multi-switch/meta-fields",
        json={
            "name": "jira",
            "display_name": "Jira",
            "field_type": "string",
            "allow_multiple": True,
        },
    )
    mf_id = create.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/meta-multi-switch/meta-fields/{mf_id}",
        json={"field_type": "date"},
    )
    assert resp.status_code == 422
