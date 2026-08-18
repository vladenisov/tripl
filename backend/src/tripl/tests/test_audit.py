import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

from tripl.models.audit_log import AuditLog
from tripl.services import audit_service
from tripl.tests.conftest import TestSessionLocal


def test_redact_masks_alerting_destination_secrets() -> None:
    """Alerting destination secrets carry key names that are not the generic
    password/token/secret set, so _redact must mask them explicitly."""
    payload = {
        "webhook_url": "https://hooks.slack.com/services/T/B/XXXX",
        "bot_token": "123456:ABCDEF-telegram-token",
        "target_url": "https://example.com/webhook?auth=zzz",
        "webhook_header_value": "Bearer header-secret",
        "jira_api_token": "jira-token-value",
        "linear_api_key": "lin_api_key_value",
        "name": "Prod Slack",
    }

    redacted = audit_service._redact(payload)

    assert redacted["webhook_url"] == "***"
    assert redacted["bot_token"] == "***"
    assert redacted["target_url"] == "***"
    assert redacted["webhook_header_value"] == "***"
    assert redacted["jira_api_token"] == "***"
    assert redacted["linear_api_key"] == "***"
    # Benign fields pass through untouched.
    assert redacted["name"] == "Prod Slack"


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
    assert all("example.com" in entry["user_email"].lower() for entry in hit.json()["items"])

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


@pytest.mark.asyncio
async def test_audit_paging_is_total_when_a_batch_shares_one_timestamp() -> None:
    """One bulk action writes many rows under a single ``created_at``.

    ``created_at`` is ``server_default=now()`` — ``transaction_timestamp()`` on
    Postgres — so the inbox bulk route, which files one row per incident with
    ``commit=False`` and commits once, stamps up to 200 rows identically. Ordering
    on ``created_at`` alone leaves that tie group unordered, and each LIMIT/OFFSET
    page is its own top-N sort with a different bound: rows could come back on two
    pages and others on none. The ids here are fixed and ascending so descending-id
    order is the reverse of insertion order — the assertion below fails on
    insertion order, which is what an untied sort returns.
    """
    stamp = datetime(2026, 8, 5, 12, 0, tzinfo=UTC)
    ids = [uuid.UUID(int=n) for n in range(1, 7)]

    async with TestSessionLocal() as session:
        for n, entry_id in enumerate(ids):
            session.add(
                AuditLog(
                    id=entry_id,
                    created_at=stamp,
                    user_email="bulk@example.com",
                    project_slug="audit-paging",
                    action="alert_inbox.mute",
                    target_type="alert_incident",
                    target_name=f"incident-{n}",
                    payload={},
                )
            )
        await session.commit()

        pages = [
            await audit_service.list_entries(
                session, project_slug="audit-paging", limit=2, offset=offset
            )
            for offset in (0, 2, 4)
        ]

    assert [page.total for page in pages] == [6, 6, 6]
    seen = [entry.id for page in pages for entry in page.items]
    # Every row reachable from exactly one page: nothing repeated, nothing lost.
    assert sorted(seen) == sorted(ids)
    assert seen == sorted(ids, reverse=True)
