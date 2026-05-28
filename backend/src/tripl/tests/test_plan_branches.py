import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.plan_branch import PlanBranch
from tripl.models.plan_branch_approval import PlanBranchApproval
from tripl.models.user import User
from tripl.tests.conftest import TestSessionLocal


async def _create_branch(client: AsyncClient, slug: str, name: str = "feature") -> str:
    resp = await client.post(f"/api/v1/projects/{slug}/branches", json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _transition(client: AsyncClient, slug: str, branch_id: str, action: str) -> dict:
    resp = await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": action},
    )
    return resp.json() if resp.status_code == 200 else {"_status": resp.status_code}


async def _seed_plan(client: AsyncClient, slug: str) -> str:
    """Create a project with one event type (+field) and one event on main."""
    project = await client.post(
        "/api/v1/projects",
        json={"name": slug, "slug": slug, "description": ""},
    )
    assert project.status_code == 201
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "track", "display_name": "Track"},
    )
    assert et.status_code == 201
    et_id = et.json()["id"]
    field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/fields",
        json={"name": "name", "display_name": "Name", "field_type": "string"},
    )
    assert field.status_code == 201
    event = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et_id, "name": "purchase:success"},
    )
    assert event.status_code == 201
    return et_id


@pytest.mark.asyncio
async def test_main_branch_is_auto_created(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-main")
    resp = await client.get("/api/v1/projects/branch-main/branches")
    assert resp.status_code == 200
    body = resp.json()
    mains = [b for b in body["items"] if b["kind"] == "main"]
    assert len(mains) == 1
    assert mains[0]["name"] == "main"


@pytest.mark.asyncio
async def test_create_branch_deep_copies_and_isolates(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-copy")

    created = await client.post(
        "/api/v1/projects/branch-copy/branches",
        json={"name": "feature-x", "description": "wip"},
    )
    assert created.status_code == 201
    branch = created.json()
    assert branch["kind"] == "working"
    assert branch["status"] == "draft"
    assert branch["base_revision_id"] is not None
    branch_id = uuid.UUID(branch["id"])

    # The main editing API still sees exactly the one main event type — branch
    # copies do not leak into the live plan.
    main_ets = await client.get("/api/v1/projects/branch-copy/event-types")
    assert main_ets.status_code == 200
    assert len(main_ets.json()) == 1

    async with TestSessionLocal() as session:
        ets = (
            (await session.execute(select(EventType).where(EventType.name == "track")))
            .scalars()
            .all()
        )
        # One on main, one deep-copied onto the branch — distinct ids, same name.
        assert len(ets) == 2
        branch_et = next(et for et in ets if et.branch_id == branch_id)
        main_et = next(et for et in ets if et.branch_id != branch_id)
        assert branch_et.id != main_et.id

        # The branch carries its own field + event copies, FK-remapped to the
        # branch's event type.
        branch_fields = (
            (
                await session.execute(
                    select(FieldDefinition).where(
                        FieldDefinition.event_type_id == branch_et.id
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(branch_fields) == 1
        assert branch_fields[0].name == "name"

        branch_events = (
            (await session.execute(select(Event).where(Event.branch_id == branch_id)))
            .scalars()
            .all()
        )
        assert len(branch_events) == 1
        assert branch_events[0].name == "purchase:success"
        assert branch_events[0].event_type_id == branch_et.id


@pytest.mark.asyncio
async def test_delete_branch_removes_copies_keeps_main(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-del")
    created = await client.post(
        "/api/v1/projects/branch-del/branches",
        json={"name": "throwaway"},
    )
    assert created.status_code == 201
    branch_id = created.json()["id"]

    deleted = await client.delete(f"/api/v1/projects/branch-del/branches/{branch_id}")
    assert deleted.status_code == 204

    # The branch row is gone. Its copied entities are removed by the
    # branch_id ON DELETE CASCADE in Postgres; SQLite (test DB) doesn't enforce
    # FK cascades, so we assert on the parent + the main-scoped list instead.
    async with TestSessionLocal() as session:
        assert await session.get(PlanBranch, uuid.UUID(branch_id)) is None

    # Main plan is unaffected (its list filters to the main branch).
    main_ets = await client.get("/api/v1/projects/branch-del/event-types")
    assert main_ets.status_code == 200
    assert len(main_ets.json()) == 1


@pytest.mark.asyncio
async def test_main_branch_cannot_be_deleted(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-guard")
    branches = await client.get("/api/v1/projects/branch-guard/branches")
    main = next(b for b in branches.json()["items"] if b["kind"] == "main")

    resp = await client.delete(f"/api/v1/projects/branch-guard/branches/{main['id']}")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_duplicate_branch_name_rejected(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-dup")
    first = await client.post(
        "/api/v1/projects/branch-dup/branches",
        json={"name": "dupe"},
    )
    assert first.status_code == 201
    second = await client.post(
        "/api/v1/projects/branch-dup/branches",
        json={"name": "dupe"},
    )
    assert second.status_code == 409

    # 'main' is reserved.
    reserved = await client.post(
        "/api/v1/projects/branch-dup/branches",
        json={"name": "main"},
    )
    assert reserved.status_code == 422


@pytest.mark.asyncio
async def test_branch_transition_state_machine(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-wf")
    branch_id = await _create_branch(client, "branch-wf")

    # draft → approve is illegal (must submit first)
    bad = await client.post(
        f"/api/v1/projects/branch-wf/branches/{branch_id}/transition",
        json={"action": "approve"},
    )
    assert bad.status_code == 409

    detail = await _transition(client, "branch-wf", branch_id, "submit")
    assert detail["status"] == "ready_for_review"

    detail = await _transition(client, "branch-wf", branch_id, "approve")
    assert detail["status"] == "approved"
    assert len(detail["approvals"]) == 1

    detail = await _transition(client, "branch-wf", branch_id, "request_changes")
    assert detail["status"] == "changes_requested"
    # request_changes is one of the approval-clearing actions.
    assert detail["approvals"] == []

    detail = await _transition(client, "branch-wf", branch_id, "submit")
    assert detail["status"] == "ready_for_review"

    detail = await _transition(client, "branch-wf", branch_id, "close")
    assert detail["status"] == "closed"


@pytest.mark.asyncio
async def test_approval_persisted_then_cleared_in_db(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-appr")
    branch_id = await _create_branch(client, "branch-appr")

    await _transition(client, "branch-appr", branch_id, "submit")
    await _transition(client, "branch-appr", branch_id, "approve")

    async with TestSessionLocal() as session:
        approvals = (
            (
                await session.execute(
                    select(PlanBranchApproval).where(
                        PlanBranchApproval.branch_id == uuid.UUID(branch_id)
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(approvals) == 1

    await _transition(client, "branch-appr", branch_id, "request_changes")

    async with TestSessionLocal() as session:
        remaining = (
            (
                await session.execute(
                    select(PlanBranchApproval).where(
                        PlanBranchApproval.branch_id == uuid.UUID(branch_id)
                    )
                )
            )
            .scalars()
            .all()
        )
        assert remaining == []


@pytest.mark.asyncio
async def test_main_branch_rejects_transitions(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-main-reject")
    branches = await client.get("/api/v1/projects/branch-main-reject/branches")
    main_id = next(b for b in branches.json()["items"] if b["kind"] == "main")["id"]
    resp = await client.post(
        f"/api/v1/projects/branch-main-reject/branches/{main_id}/transition",
        json={"action": "submit"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_reviewers_add_list_remove(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-rev")
    branch_id = await _create_branch(client, "branch-rev")

    # Seed a second user (reviewer candidate) directly — the auth endpoints would
    # log us out as the new user, which is not what we want here.
    reviewer_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        session.add(
            User(
                id=reviewer_id,
                email="reviewer@example.com",
                password_hash="!seed",
                role="editor",
            )
        )
        await session.commit()

    added = await client.post(
        f"/api/v1/projects/branch-rev/branches/{branch_id}/reviewers",
        json={"user_id": str(reviewer_id)},
    )
    assert added.status_code == 201
    assert added.json()["user_id"] == str(reviewer_id)

    detail = await client.get(f"/api/v1/projects/branch-rev/branches/{branch_id}")
    assert any(r["user_id"] == str(reviewer_id) for r in detail.json()["reviewers"])

    removed = await client.delete(
        f"/api/v1/projects/branch-rev/branches/{branch_id}/reviewers/{reviewer_id}"
    )
    assert removed.status_code == 204

    detail2 = await client.get(f"/api/v1/projects/branch-rev/branches/{branch_id}")
    assert detail2.json()["reviewers"] == []


@pytest.mark.asyncio
async def test_branch_comments_threaded(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-cmt")
    branch_id = await _create_branch(client, "branch-cmt")

    root = await client.post(
        f"/api/v1/projects/branch-cmt/branches/{branch_id}/comments",
        json={"body": "Looks good but…"},
    )
    assert root.status_code == 201
    root_id = root.json()["id"]
    assert root.json()["parent_id"] is None

    reply = await client.post(
        f"/api/v1/projects/branch-cmt/branches/{branch_id}/comments",
        json={"body": "fixed", "parent_id": root_id},
    )
    assert reply.status_code == 201
    assert reply.json()["parent_id"] == root_id

    listed = await client.get(
        f"/api/v1/projects/branch-cmt/branches/{branch_id}/comments"
    )
    bodies = [c["body"] for c in listed.json()]
    assert bodies == ["Looks good but…", "fixed"]

    deleted = await client.delete(
        f"/api/v1/projects/branch-cmt/branches/{branch_id}/comments/{root_id}"
    )
    assert deleted.status_code == 204


@pytest.mark.asyncio
async def test_empty_body_comment_rejected(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-cmt-empty")
    branch_id = await _create_branch(client, "branch-cmt-empty")
    resp = await client.post(
        f"/api/v1/projects/branch-cmt-empty/branches/{branch_id}/comments",
        json={"body": "   "},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_diff_initially_empty_then_behind_base(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-diff")
    branch_id = await _create_branch(client, "branch-diff")

    initial = await client.get(f"/api/v1/projects/branch-diff/branches/{branch_id}/diff")
    assert initial.status_code == 200
    body = initial.json()
    # Right after deep-copy the branch mirrors main: no entries, not behind base.
    assert body["entries"] == []
    assert body["summary"] == {"added": 0, "removed": 0, "changed": 0}
    assert body["behind_base"] is False

    # Advance main by adding a new event type. The branch now lags its base.
    await client.post(
        "/api/v1/projects/branch-diff/event-types",
        json={"name": "alerts", "display_name": "Alerts"},
    )

    after = await client.get(f"/api/v1/projects/branch-diff/branches/{branch_id}/diff")
    assert after.status_code == 200
    after_body = after.json()
    # The new event type exists on main but not the branch — branch reports it
    # as "removed" relative to main.
    assert after_body["behind_base"] is True
    kinds = {e["kind"] for e in after_body["entries"]}
    assert "removed" in kinds


@pytest.mark.asyncio
async def test_diff_rejects_main_branch(client: AsyncClient) -> None:
    await _seed_plan(client, "branch-diff-main")
    branches = await client.get("/api/v1/projects/branch-diff-main/branches")
    main_id = next(b for b in branches.json()["items"] if b["kind"] == "main")["id"]
    resp = await client.get(
        f"/api/v1/projects/branch-diff-main/branches/{main_id}/diff"
    )
    assert resp.status_code == 400
