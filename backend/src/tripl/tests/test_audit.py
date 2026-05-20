import pytest
from httpx import AsyncClient


async def _setup_project(client: AsyncClient, slug: str = "audit-proj") -> str:
    await client.post("/api/v1/projects", json={"name": "A", "slug": slug})
    resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "PV"},
    )
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_audit_records_field_lifecycle(client: AsyncClient) -> None:
    et_id = await _setup_project(client, "audit-fields")

    create = await client.post(
        f"/api/v1/projects/audit-fields/event-types/{et_id}/fields",
        json={"name": "email", "display_name": "Email", "field_type": "string"},
    )
    assert create.status_code == 201
    field_id = create.json()["id"]

    patch = await client.patch(
        f"/api/v1/projects/audit-fields/event-types/{et_id}/fields/{field_id}",
        json={"sensitivity": "pii"},
    )
    assert patch.status_code == 200

    delete = await client.delete(
        f"/api/v1/projects/audit-fields/event-types/{et_id}/fields/{field_id}"
    )
    assert delete.status_code == 204

    audit = await client.get("/api/v1/audit?project_slug=audit-fields")
    assert audit.status_code == 200
    body = audit.json()
    actions = {entry["action"] for entry in body["items"]}
    # All three field actions plus the event-type create from setup.
    assert {"field.create", "field.update", "field.delete"} <= actions
    # User email is denormalized for retention after user deletion.
    assert all(entry["user_email"] == "test@example.com" for entry in body["items"])
    # Update payload captures only the fields the client actually changed.
    update_entry = next(e for e in body["items"] if e["action"] == "field.update")
    assert update_entry["payload"] == {"sensitivity": "pii"}


@pytest.mark.asyncio
async def test_audit_redacts_data_source_password(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": "Prod CH",
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "default",
            "username": "default",
            "password": "super-secret",
        },
    )
    assert resp.status_code == 201

    audit = await client.get("/api/v1/audit?action=data_source.create")
    assert audit.status_code == 200
    items = audit.json()["items"]
    assert len(items) == 1
    payload = items[0]["payload"]
    assert payload["password"] == "***"
    assert payload["host"] == "localhost"


@pytest.mark.asyncio
async def test_audit_filters_by_action_and_project(client: AsyncClient) -> None:
    await _setup_project(client, "audit-a")
    await _setup_project(client, "audit-b")

    by_action = await client.get("/api/v1/audit?action=event_type.create")
    assert by_action.status_code == 200
    assert by_action.json()["total"] == 2

    by_project = await client.get("/api/v1/audit?project_slug=audit-a")
    assert by_project.status_code == 200
    slugs = {entry["project_slug"] for entry in by_project.json()["items"]}
    assert slugs == {"audit-a"}


@pytest.mark.asyncio
async def test_audit_filters_by_user_email_substring(client: AsyncClient) -> None:
    await _setup_project(client, "audit-email")

    # The conftest client is registered as test@example.com.
    hit = await client.get("/api/v1/audit?user_email=example.com")
    assert hit.status_code == 200
    assert hit.json()["total"] >= 1
    assert all(
        "example.com" in entry["user_email"].lower()
        for entry in hit.json()["items"]
    )

    miss = await client.get("/api/v1/audit?user_email=nobody")
    assert miss.status_code == 200
    assert miss.json()["total"] == 0


@pytest.mark.asyncio
async def test_audit_covers_meta_field_variable_revision(client: AsyncClient) -> None:
    """Wire-in sanity: meta_field / variable / plan_revision all emit audit
    entries with the right action namespace."""
    await _setup_project(client, "audit-wide")

    mf = await client.post(
        "/api/v1/projects/audit-wide/meta-fields",
        json={"name": "jira_key", "display_name": "Jira", "field_type": "string"},
    )
    assert mf.status_code == 201
    mf_id = mf.json()["id"]
    patch = await client.patch(
        f"/api/v1/projects/audit-wide/meta-fields/{mf_id}",
        json={"is_required": True},
    )
    assert patch.status_code == 200
    delete = await client.delete(f"/api/v1/projects/audit-wide/meta-fields/{mf_id}")
    assert delete.status_code == 204

    var = await client.post(
        "/api/v1/projects/audit-wide/variables",
        json={"name": "user_id", "variable_type": "string"},
    )
    assert var.status_code == 201

    rev = await client.post(
        "/api/v1/projects/audit-wide/revisions",
        json={"summary": "first snapshot"},
    )
    assert rev.status_code == 201

    audit = await client.get("/api/v1/audit?project_slug=audit-wide")
    actions = {entry["action"] for entry in audit.json()["items"]}
    assert {
        "meta_field.create",
        "meta_field.update",
        "meta_field.delete",
        "variable.create",
        "plan_revision.create",
    } <= actions
