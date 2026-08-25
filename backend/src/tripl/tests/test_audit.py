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
    # A list row carries NO payload. The tab renders one only for the row a
    # reader expanded, so a page of blobs crossed the wire to be displayed
    # nowhere (tripl-5ydt).
    update_entry = next(e for e in body["items"] if e["action"] == "field.update")
    assert "payload" not in update_entry

    # The detail route still reports exactly the fields the client changed.
    detail = await client.get(f"/api/v1/audit/{update_entry['id']}")
    assert detail.status_code == 200
    assert detail.json()["payload"] == {"sensitivity": "pii"}


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
    detail = await client.get(f"/api/v1/audit/{items[0]['id']}")
    assert detail.status_code == 200
    payload = detail.json()["payload"]
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


@pytest.mark.asyncio
async def test_audit_detail_is_owner_only(client: AsyncClient) -> None:
    """The payload moved to its own route, and the gate had to move with it.

    The feed is owner-only because entries carry the warehouse connection
    details a direct read blanks for non-owners, and the ``base_query`` SQL
    authoring a scan is owner-only to protect (test_rbac.py's
    ``test_audit_log_is_owner_only``). Those fields now leave the API through
    THIS route only, so an ungated get-one would reopen exactly that back door.
    """
    await _setup_project(client, "audit-gate")
    listed = await client.get("/api/v1/audit?project_slug=audit-gate")
    entry_id = listed.json()["items"][0]["id"]

    # The conftest client registered first and is therefore the owner; the next
    # registration defaults to editor.
    await client.post("/api/v1/auth/logout")
    register = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "audit-editor@example.com",
            "password": "Password123!",
            "name": "Audit Editor",
        },
    )
    assert register.status_code == 201, register.text

    denied = await client.get(f"/api/v1/audit/{entry_id}")
    assert denied.status_code == 403


@pytest.mark.asyncio
async def test_audit_detail_reports_an_unknown_id_as_missing(client: AsyncClient) -> None:
    resp = await client.get(f"/api/v1/audit/{uuid.uuid4()}")
    assert resp.status_code == 404


# --- branch context on audit rows (tripl-wkwv.6) ----------------------------


async def _create_branch(client: AsyncClient, slug: str, name: str) -> str:
    resp = await client.post(f"/api/v1/projects/{slug}/branches", json={"name": name})
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def _one_entry(client: AsyncClient, slug: str, action: str) -> dict:
    """The single audit row for ``action`` on ``slug``, as the list renders it."""
    listed = await client.get(f"/api/v1/audit?project_slug={slug}&action={action}")
    assert listed.status_code == 200
    items = listed.json()["items"]
    assert len(items) == 1, items
    return dict(items[0])


@pytest.mark.asyncio
async def test_audit_records_the_branch_a_write_was_scoped_to(client: AsyncClient) -> None:
    """PR #143 made ``?branch=`` an ordinary, documented way to write, but the
    audit row could not say which plan it wrote to: two contradictory edits to
    the same object on two branches produced two identical-looking rows."""
    await _setup_project(client, "audit-branch")
    branch_id = await _create_branch(client, "audit-branch", "redesign-checkout")

    created = await client.post(
        f"/api/v1/projects/audit-branch/meta-fields?branch={branch_id}",
        json={"name": "owner", "display_name": "Owner", "field_type": "string"},
    )
    assert created.status_code == 201, created.text

    row = await _one_entry(client, "audit-branch", "meta_field.create")
    assert row["branch_id"] == branch_id
    assert row["branch_name"] == "redesign-checkout"

    # Both projections carry it: the issue asks for the list AND the owner-only
    # detail payload, and the detail response inherits the list's fields.
    detail = await client.get(f"/api/v1/audit/{row['id']}")
    assert detail.status_code == 200
    assert detail.json()["branch_id"] == branch_id
    assert detail.json()["branch_name"] == "redesign-checkout"


@pytest.mark.asyncio
async def test_audit_on_main_records_no_branch(client: AsyncClient) -> None:
    """No ``?branch=`` means main, and main is spelled as the absence of a
    branch — no synthetic main id, so nothing has to be backfilled."""
    await _setup_project(client, "audit-main")

    created = await client.post(
        "/api/v1/projects/audit-main/meta-fields",
        json={"name": "owner", "display_name": "Owner", "field_type": "string"},
    )
    assert created.status_code == 201, created.text

    row = await _one_entry(client, "audit-main", "meta_field.create")
    assert row["branch_id"] is None
    assert row["branch_name"] == ""


@pytest.mark.asyncio
async def test_an_explicit_main_branch_id_records_no_branch_either(client: AsyncClient) -> None:
    """``GET /branches`` hands an API caller main's own id, and every write route
    accepts it — nothing filters on ``kind``.

    Main is spelled as the absence of a branch everywhere else (the chip, the
    schema docstring, the CLI's "there is no literal for main"), so binding it
    here would spell it a second way: two identical writes to main, one with the
    parameter and one without, would render differently in the same compliance
    trail and the chip would read "main" (tripl-wkwv.6).
    """
    await _setup_project(client, "audit-main-id")
    listed = await client.get("/api/v1/projects/audit-main-id/branches")
    assert listed.status_code == 200, listed.text
    main_id = next(b["id"] for b in listed.json()["items"] if b["kind"] == "main")

    created = await client.post(
        f"/api/v1/projects/audit-main-id/meta-fields?branch={main_id}",
        json={"name": "owner", "display_name": "Owner", "field_type": "string"},
    )
    # The write still targets main exactly as it does with no parameter at all.
    assert created.status_code == 201, created.text

    row = await _one_entry(client, "audit-main-id", "meta_field.create")
    assert row["branch_id"] is None
    assert row["branch_name"] == ""


@pytest.mark.asyncio
async def test_branch_context_does_not_leak_into_the_next_request(client: AsyncClient) -> None:
    """The branch is carried on a request-scoped contextvar, so unbinding it is
    the whole correctness argument.

    Under uvicorn each request cycle is its own task and so its own ``Context``,
    which would hide a missing reset entirely. The suite drives the app through
    ``httpx.ASGITransport`` (conftest.py), which awaits the app in the CALLER's
    task — so dropping the ``finally: reset(token)`` in ``bound_branch`` stamps
    the branch of the first write onto every later row this client writes,
    including rows on routes that have no branch dimension at all.
    """
    await _setup_project(client, "audit-leak")
    branch_id = await _create_branch(client, "audit-leak", "feature-leak")

    scoped = await client.post(
        f"/api/v1/projects/audit-leak/meta-fields?branch={branch_id}",
        json={"name": "owner", "display_name": "Owner", "field_type": "string"},
    )
    assert scoped.status_code == 201, scoped.text
    assert (await _one_entry(client, "audit-leak", "meta_field.create"))["branch_id"] == branch_id

    # A route that declares no branch dependency at all, through the SAME client.
    revision = await client.post(
        "/api/v1/projects/audit-leak/revisions",
        json={"summary": "after the branch write"},
    )
    assert revision.status_code == 201, revision.text

    row = await _one_entry(client, "audit-leak", "plan_revision.create")
    assert row["branch_id"] is None
    assert row["branch_name"] == ""


@pytest.mark.asyncio
async def test_deleting_a_branch_keeps_the_branch_name_on_its_audit_rows(
    client: AsyncClient,
) -> None:
    """``branch_name`` is denormalized because the FK erases itself.

    ``plan_branch.delete`` hard-deletes the row and the FK is ``ON DELETE SET
    NULL``, so an id-only column would wipe the branch context from exactly the
    rows that recorded that branch's work — the same reason ``user_email`` and
    ``project_slug`` sit next to their ids.
    """
    await _setup_project(client, "audit-branch-gone")
    branch_id = await _create_branch(client, "audit-branch-gone", "short-lived")
    created = await client.post(
        f"/api/v1/projects/audit-branch-gone/meta-fields?branch={branch_id}",
        json={"name": "owner", "display_name": "Owner", "field_type": "string"},
    )
    assert created.status_code == 201, created.text

    deleted = await client.delete(f"/api/v1/projects/audit-branch-gone/branches/{branch_id}")
    assert deleted.status_code == 204, deleted.text

    row = await _one_entry(client, "audit-branch-gone", "meta_field.create")
    assert row["branch_id"] is None
    assert row["branch_name"] == "short-lived"


@pytest.mark.asyncio
async def test_a_malformed_branch_still_answers_400_and_writes_nothing(
    client: AsyncClient,
) -> None:
    """Binding the branch turned the dependency into a generator; every raise
    has to stay AHEAD of its first yield or 400 becomes a 500 (or a 422)."""
    await _setup_project(client, "audit-bad-branch")

    resp = await client.post(
        "/api/v1/projects/audit-bad-branch/meta-fields?branch=not-a-uuid",
        json={"name": "owner", "display_name": "Owner", "field_type": "string"},
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid branch id"
    listed = await client.get(
        "/api/v1/audit?project_slug=audit-bad-branch&action=meta_field.create"
    )
    assert listed.json()["items"] == []
