import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tripl.models.event import Event
from tripl.models.event_photo import EventPhoto
from tripl.models.event_photo_comment import EventPhotoComment
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
                    select(FieldDefinition).where(FieldDefinition.event_type_id == branch_et.id)
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

    listed = await client.get(f"/api/v1/projects/branch-cmt/branches/{branch_id}/comments")
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
    resp = await client.get(f"/api/v1/projects/branch-diff-main/branches/{main_id}/diff")
    assert resp.status_code == 400


# --- Phase 4: merge engine ------------------------------------------------


async def _approve_and_merge(client: AsyncClient, slug: str, branch_id: str):
    await _transition(client, slug, branch_id, "submit")
    await _transition(client, slug, branch_id, "approve")
    return await client.post(f"/api/v1/projects/{slug}/branches/{branch_id}/merge")


@pytest.mark.asyncio
async def test_merge_requires_approved_status(client: AsyncClient) -> None:
    await _seed_plan(client, "merge-gate")
    branch_id = await _create_branch(client, "merge-gate")
    resp = await client.post(f"/api/v1/projects/merge-gate/branches/{branch_id}/merge")
    assert resp.status_code == 409  # status is draft, not approved


@pytest.mark.asyncio
async def test_merge_rejects_main_branch(client: AsyncClient) -> None:
    await _seed_plan(client, "merge-main")
    branches = await client.get("/api/v1/projects/merge-main/branches")
    main_id = next(b for b in branches.json()["items"] if b["kind"] == "main")["id"]
    resp = await client.post(f"/api/v1/projects/merge-main/branches/{main_id}/merge")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_merge_no_op_marks_branch_merged_and_writes_revision(
    client: AsyncClient,
) -> None:
    """A branch identical to main still merges cleanly — status flips, a
    post-merge PlanRevision is recorded."""
    await _seed_plan(client, "merge-noop")
    branch_id = await _create_branch(client, "merge-noop")

    # Count revisions before merge (base snapshot + N from earlier ops).
    pre = await client.get("/api/v1/projects/merge-noop/revisions")
    pre_total = pre.json()["total"]

    resp = await _approve_and_merge(client, "merge-noop", branch_id)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "merged"
    assert body["merged_at"] is not None
    assert body["merged_by"] is not None

    post = await client.get("/api/v1/projects/merge-noop/revisions")
    assert post.json()["total"] == pre_total + 1


@pytest.mark.asyncio
async def test_merge_preserves_main_event_type_id(client: AsyncClient) -> None:
    """Branch modifies an existing event type; the live main row keeps its id
    (so runtime rows linked to it survive)."""
    await _seed_plan(client, "merge-id")

    # Pre-merge: capture the live main event_type id.
    async with TestSessionLocal() as session:
        main_branch_id = (
            (await session.execute(select(PlanBranch).where(PlanBranch.name == "main")))
            .scalars()
            .first()
            .id
        )
        original_et = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.name == "track", EventType.branch_id == main_branch_id
                    )
                )
            )
            .scalars()
            .first()
        )
        original_et_id = original_et.id

    branch_id = await _create_branch(client, "merge-id")

    # Mutate the branch's copy via ORM (the ?branch= editing API lands in Phase 5).
    async with TestSessionLocal() as session:
        branch_et = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.name == "track",
                        EventType.branch_id == uuid.UUID(branch_id),
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_et.color = "#ff0000"
        branch_et.description = "renamed on branch"
        await session.commit()

    resp = await _approve_and_merge(client, "merge-id", branch_id)
    assert resp.status_code == 200

    async with TestSessionLocal() as session:
        survived = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.name == "track", EventType.branch_id == main_branch_id
                    )
                )
            )
            .scalars()
            .first()
        )
        # Same id => attached metrics/photos/alerts survive the merge.
        assert survived.id == original_et_id
        assert survived.color == "#ff0000"
        assert survived.description == "renamed on branch"


@pytest.mark.asyncio
async def test_merge_adds_and_removes_event_types(client: AsyncClient) -> None:
    await _seed_plan(client, "merge-add-rm")
    branch_id = await _create_branch(client, "merge-add-rm")

    async with TestSessionLocal() as session:
        # Branch removes "track" and adds "checkout".
        branch_uuid = uuid.UUID(branch_id)
        branch_track = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.name == "track", EventType.branch_id == branch_uuid
                    )
                )
            )
            .scalars()
            .first()
        )
        # Branch events also reference branch_track — drop the matching event too.
        branch_track_event = (
            (
                await session.execute(
                    select(Event).where(
                        Event.branch_id == branch_uuid, Event.name == "purchase:success"
                    )
                )
            )
            .scalars()
            .first()
        )
        await session.delete(branch_track_event)
        await session.delete(branch_track)
        # Add a new event type on the branch.
        session.add(
            EventType(
                id=uuid.uuid4(),
                project_id=branch_track.project_id,
                branch_id=branch_uuid,
                name="checkout",
                display_name="Checkout",
                description="",
                color="#00ff00",
                order=1,
            )
        )
        await session.commit()

    resp = await _approve_and_merge(client, "merge-add-rm", branch_id)
    assert resp.status_code == 200

    main_ets = await client.get("/api/v1/projects/merge-add-rm/event-types")
    names = {et["name"] for et in main_ets.json()}
    assert "track" not in names
    assert "checkout" in names


@pytest.mark.asyncio
async def test_merge_3way_auto_merges_non_overlapping_field_changes(
    client: AsyncClient,
) -> None:
    """Main and branch edit different fields of the same event type — true
    3-way merge keeps both sides without a conflict."""
    await _seed_plan(client, "merge-3way")
    branch_id = await _create_branch(client, "merge-3way")

    main_ets = await client.get("/api/v1/projects/merge-3way/event-types")
    main_track_id = next(et["id"] for et in main_ets.json() if et["name"] == "track")
    await client.patch(
        f"/api/v1/projects/merge-3way/event-types/{main_track_id}",
        json={"color": "#0000ff"},
    )

    async with TestSessionLocal() as session:
        branch_track = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.name == "track",
                        EventType.branch_id == uuid.UUID(branch_id),
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_track.description = "changed on branch"
        await session.commit()

    resp = await _approve_and_merge(client, "merge-3way", branch_id)
    assert resp.status_code == 200, resp.text

    main_after = await client.get(f"/api/v1/projects/merge-3way/event-types/{main_track_id}")
    body = main_after.json()
    # Main's color edit survives; branch's description edit lands too.
    assert body["color"] == "#0000ff"
    assert body["description"] == "changed on branch"


@pytest.mark.asyncio
async def test_merge_blocks_on_same_field_conflict_until_resolved(
    client: AsyncClient,
) -> None:
    """Both sides edit the *same* event_type field with different values →
    409 with unresolved_field_conflicts; once a resolution is saved, merge
    proceeds with the chosen value."""
    await _seed_plan(client, "merge-fconflict")
    branch_id = await _create_branch(client, "merge-fconflict")

    main_ets = await client.get("/api/v1/projects/merge-fconflict/event-types")
    main_track_id = next(et["id"] for et in main_ets.json() if et["name"] == "track")
    await client.patch(
        f"/api/v1/projects/merge-fconflict/event-types/{main_track_id}",
        json={"color": "#aaaaaa"},
    )

    async with TestSessionLocal() as session:
        branch_track = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.name == "track",
                        EventType.branch_id == uuid.UUID(branch_id),
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_track.color = "#bbbbbb"
        await session.commit()

    first = await _approve_and_merge(client, "merge-fconflict", branch_id)
    assert first.status_code == 409
    unresolved = first.json()["detail"]["unresolved_field_conflicts"]
    assert any(
        c["entity_type"] == "event_type" and c["name"] == "track" and c["field"] == "color"
        for c in unresolved
    )

    # Inspect the rich conflicts payload and pick "ours" for the color field.
    conflicts = await client.get(f"/api/v1/projects/merge-fconflict/branches/{branch_id}/conflicts")
    assert conflicts.status_code == 200
    body = conflicts.json()
    assert body["unresolved_count"] == 1
    entity = body["entities"][0]
    assert entity["fields"][0]["field"] == "color"
    assert entity["fields"][0]["ours"] == "#aaaaaa"
    assert entity["fields"][0]["theirs"] == "#bbbbbb"

    save = await client.post(
        f"/api/v1/projects/merge-fconflict/branches/{branch_id}/resolutions",
        json={
            "entity_type": "event_type",
            "entity_name": "track",
            "field_name": "color",
            "choice": "ours",
        },
    )
    assert save.status_code == 201

    # Branch is now in 'merged' state? No — it was approved → merge failed →
    # status is still approved. Just call merge again; transitions stay intact.
    merge = await client.post(f"/api/v1/projects/merge-fconflict/branches/{branch_id}/merge")
    assert merge.status_code == 200, merge.text

    main_after = await client.get(f"/api/v1/projects/merge-fconflict/event-types/{main_track_id}")
    # "ours" wins for color — main's value survives the merge.
    assert main_after.json()["color"] == "#aaaaaa"


@pytest.mark.asyncio
async def test_resolutions_cleared_on_branch_reopen(client: AsyncClient) -> None:
    """Reopening the branch (back to draft) drops any captured resolutions —
    the reviewer must re-pick against the new base/ours/theirs."""
    await _seed_plan(client, "merge-clear-res")
    branch_id = await _create_branch(client, "merge-clear-res")

    async with TestSessionLocal() as session:
        branch_track = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.name == "track",
                        EventType.branch_id == uuid.UUID(branch_id),
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_track.color = "#cccccc"
        await session.commit()

    await client.patch(
        f"/api/v1/projects/merge-clear-res/event-types/"
        f"{(await client.get('/api/v1/projects/merge-clear-res/event-types')).json()[0]['id']}",
        json={"color": "#dddddd"},
    )

    save = await client.post(
        f"/api/v1/projects/merge-clear-res/branches/{branch_id}/resolutions",
        json={
            "entity_type": "event_type",
            "entity_name": "track",
            "field_name": "color",
            "choice": "theirs",
        },
    )
    assert save.status_code == 201

    # Push the branch back to draft via reopen — transition path used by the
    # UI when changes are requested.
    await client.post(
        f"/api/v1/projects/merge-clear-res/branches/{branch_id}/transition",
        json={"action": "submit"},
    )
    await client.post(
        f"/api/v1/projects/merge-clear-res/branches/{branch_id}/transition",
        json={"action": "approve"},
    )
    await client.post(
        f"/api/v1/projects/merge-clear-res/branches/{branch_id}/transition",
        json={"action": "reopen"},
    )

    conflicts = await client.get(f"/api/v1/projects/merge-clear-res/branches/{branch_id}/conflicts")
    assert conflicts.status_code == 200
    body = conflicts.json()
    # Resolutions are gone — every conflict is unresolved again.
    assert body["unresolved_count"] == 1
    for entity in body["entities"]:
        for field in entity["fields"]:
            assert field["choice"] is None


# --- event_photos branching --------------------------------------------------


async def _attach_main_figma(
    client: AsyncClient, slug: str, event_id: str, url: str, title: str
) -> str:
    resp = await client.post(
        f"/api/v1/projects/{slug}/events/{event_id}/photos/figma",
        json={"url": url, "title": title},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_branch_create_copies_event_photos_and_comments(
    client: AsyncClient,
) -> None:
    """Creating a branch deep-copies photos + threaded comments onto the
    branch's events with fresh ids and FK remap."""
    await _seed_plan(client, "branch-photos")
    events = await client.get("/api/v1/projects/branch-photos/events")
    main_event_id = events.json()["items"][0]["id"]
    main_photo_id = await _attach_main_figma(
        client,
        "branch-photos",
        main_event_id,
        "https://www.figma.com/file/abc/Spec",
        "Spec",
    )
    # One top-level comment + one reply.
    base = f"/api/v1/projects/branch-photos/events/{main_event_id}/photos/{main_photo_id}/comments"
    top = await client.post(base, json={"body": "looks good"})
    assert top.status_code == 201
    reply = await client.post(base, json={"body": "thanks!", "parent_id": top.json()["id"]})
    assert reply.status_code == 201

    branch_id = await _create_branch(client, "branch-photos", "feature-photos")

    async with TestSessionLocal() as session:
        branch_event = (
            (await session.execute(select(Event).where(Event.branch_id == uuid.UUID(branch_id))))
            .scalars()
            .first()
        )
        assert branch_event is not None
        assert branch_event.id != uuid.UUID(main_event_id)

        branch_photos = (
            (
                await session.execute(
                    select(EventPhoto).where(EventPhoto.event_id == branch_event.id)
                )
            )
            .scalars()
            .all()
        )
        assert len(branch_photos) == 1
        branch_photo = branch_photos[0]
        # Fresh id but the same blob target (storage_key/external_url reused).
        assert branch_photo.id != uuid.UUID(main_photo_id)
        assert branch_photo.external_url == "https://www.figma.com/file/abc/Spec"
        assert branch_photo.kind == "figma"

        branch_comments = (
            (
                await session.execute(
                    select(EventPhotoComment).where(EventPhotoComment.photo_id == branch_photo.id)
                )
            )
            .scalars()
            .all()
        )
        assert {c.body for c in branch_comments} == {"looks good", "thanks!"}
        # The reply's parent_id was remapped to the branch's top-level comment.
        top_branch = next(c for c in branch_comments if c.parent_id is None)
        reply_branch = next(c for c in branch_comments if c.parent_id is not None)
        assert reply_branch.parent_id == top_branch.id


@pytest.mark.asyncio
async def test_merge_carries_branch_photo_changes_to_main(client: AsyncClient) -> None:
    """Branch removes a main photo and attaches a new one; merge replaces
    main's photo set with the branch's set (reachable as the source of truth)."""
    await _seed_plan(client, "merge-photos")
    events = await client.get("/api/v1/projects/merge-photos/events")
    main_event_id = events.json()["items"][0]["id"]
    await _attach_main_figma(
        client,
        "merge-photos",
        main_event_id,
        "https://www.figma.com/file/old/Old",
        "Old",
    )

    branch_id = await _create_branch(client, "merge-photos", "feature-art")

    async with TestSessionLocal() as session:
        branch_event = (
            (await session.execute(select(Event).where(Event.branch_id == uuid.UUID(branch_id))))
            .scalars()
            .first()
        )
        branch_event_id = branch_event.id
        # Drop the deep-copied photo from the branch.
        branch_photos = (
            (
                await session.execute(
                    select(EventPhoto).where(EventPhoto.event_id == branch_event_id)
                )
            )
            .scalars()
            .all()
        )
        for ph in branch_photos:
            await session.delete(ph)
        await session.commit()

    # Attach a new figma row directly on the branch event.
    new_url = "https://www.figma.com/file/new/New"
    await _attach_main_figma(client, "merge-photos", str(branch_event_id), new_url, "New")

    resp = await _approve_and_merge(client, "merge-photos", branch_id)
    assert resp.status_code == 200

    # On main, the live event now carries the branch's photo set: one figma row
    # with the new URL, the old one gone.
    listed = await client.get(f"/api/v1/projects/merge-photos/events/{main_event_id}/photos")
    assert listed.status_code == 200
    urls = [row["external_url"] for row in listed.json()]
    assert urls == [new_url]


# --- ?branch= router param threading ----------------------------------------


@pytest.mark.asyncio
async def test_router_branch_param_lists_branch_event_types(client: AsyncClient) -> None:
    """GET /event-types?branch=<id> returns the branch's deep copy, not main's."""
    await _seed_plan(client, "branch-route-list")
    branch_id = await _create_branch(client, "branch-route-list", "feature-A")

    # Editing on the branch adds a second event type; main keeps its one.
    create_resp = await client.post(
        f"/api/v1/projects/branch-route-list/event-types?branch={branch_id}",
        json={"name": "checkout", "display_name": "Checkout"},
    )
    assert create_resp.status_code == 201

    main_list = (await client.get("/api/v1/projects/branch-route-list/event-types")).json()
    assert {et["name"] for et in main_list} == {"track"}

    branch_list = (
        await client.get(f"/api/v1/projects/branch-route-list/event-types?branch={branch_id}")
    ).json()
    assert {et["name"] for et in branch_list} == {"track", "checkout"}


@pytest.mark.asyncio
async def test_router_branch_param_threads_variables(client: AsyncClient) -> None:
    """Variables CRUD scoped to a branch leaves main untouched."""
    await _seed_plan(client, "branch-route-vars")
    branch_id = await _create_branch(client, "branch-route-vars", "feature-vars")

    create_resp = await client.post(
        f"/api/v1/projects/branch-route-vars/variables?branch={branch_id}",
        json={"name": "spot_id", "variable_type": "string"},
    )
    assert create_resp.status_code == 201

    main_vars = (await client.get("/api/v1/projects/branch-route-vars/variables")).json()
    assert main_vars == []

    branch_vars = (
        await client.get(f"/api/v1/projects/branch-route-vars/variables?branch={branch_id}")
    ).json()
    assert [v["name"] for v in branch_vars] == ["spot_id"]


@pytest.mark.asyncio
async def test_router_branch_param_invalid_uuid_returns_400(client: AsyncClient) -> None:
    """Malformed ?branch= value yields 400 — the dep rejects before service runs."""
    await _seed_plan(client, "branch-route-bad")
    resp = await client.get("/api/v1/projects/branch-route-bad/event-types?branch=not-a-uuid")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_router_branch_param_cross_project_404(client: AsyncClient) -> None:
    """A real branch id belonging to another project is rejected as 404."""
    await _seed_plan(client, "branch-route-iso-a")
    await _seed_plan(client, "branch-route-iso-b")
    other_branch_id = await _create_branch(client, "branch-route-iso-b", "feature-b")
    resp = await client.get(
        f"/api/v1/projects/branch-route-iso-a/event-types?branch={other_branch_id}"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_router_branch_param_threads_meta_fields(client: AsyncClient) -> None:
    """Meta-field create on branch is isolated from main."""
    await _seed_plan(client, "branch-route-meta")
    branch_id = await _create_branch(client, "branch-route-meta", "feature-meta")

    create_resp = await client.post(
        f"/api/v1/projects/branch-route-meta/meta-fields?branch={branch_id}",
        json={"name": "owner", "display_name": "Owner", "field_type": "string"},
    )
    assert create_resp.status_code == 201

    main_mf = (await client.get("/api/v1/projects/branch-route-meta/meta-fields")).json()
    assert main_mf == []
    branch_mf = (
        await client.get(f"/api/v1/projects/branch-route-meta/meta-fields?branch={branch_id}")
    ).json()
    assert [mf["name"] for mf in branch_mf] == ["owner"]


# --- event merge: source_name preservation (scan dedup integrity) -----------


@pytest.mark.asyncio
async def test_merge_preserves_event_source_name(client: AsyncClient) -> None:
    """Merge must carry an event's ``source_name`` from branch to main on BOTH
    the update-existing and create-new paths.

    Scan dedup (worker event_generator) keys on ``source_name``; if a merged
    event lands with ``source_name`` unset it gets backfilled to ``name`` and
    re-duplicates as a shadow row, detaching metrics. This guards that data
    integrity invariant.
    """
    await _seed_plan(client, "merge-source-name")

    main_branch_id_str = None
    async with TestSessionLocal() as session:
        main_branch = (
            (await session.execute(select(PlanBranch).where(PlanBranch.name == "main")))
            .scalars()
            .first()
        )
        main_branch_id_str = main_branch.id
        # Give the live main event a runtime-distinct source_name (as the scan
        # worker would have stamped it: differs from the editable display name).
        main_event = (
            (
                await session.execute(
                    select(Event).where(
                        Event.branch_id == main_branch.id, Event.name == "purchase:success"
                    )
                )
            )
            .scalars()
            .first()
        )
        main_event.source_name = "purchase_success_raw"
        await session.commit()

    branch_id = await _create_branch(client, "merge-source-name")
    branch_uuid = uuid.UUID(branch_id)

    async with TestSessionLocal() as session:
        # update-existing path: stamp the branch event's source_name (mirrors a
        # scan having run against the branch) and mutate it so the merge writes
        # back to the existing main row.
        branch_event = (
            (
                await session.execute(
                    select(Event).where(
                        Event.branch_id == branch_uuid, Event.name == "purchase:success"
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_event.source_name = "purchase_success_raw"
        branch_event.description = "edited on branch"

        # create-new path: add a brand-new event on the branch with its own
        # source_name that diverges from its display name.
        branch_et = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.name == "track", EventType.branch_id == branch_uuid
                    )
                )
            )
            .scalars()
            .first()
        )
        session.add(
            Event(
                id=uuid.uuid4(),
                project_id=branch_et.project_id,
                branch_id=branch_uuid,
                event_type_id=branch_et.id,
                name="signup:done",
                source_name="signup_done_raw",
            )
        )
        await session.commit()

    resp = await _approve_and_merge(client, "merge-source-name", branch_id)
    assert resp.status_code == 200, resp.text

    async with TestSessionLocal() as session:
        merged = {
            e.name: e
            for e in (
                await session.execute(
                    select(Event).where(Event.branch_id == main_branch_id_str)
                )
            )
            .scalars()
            .all()
        }
        # update-existing path kept the source_name (not backfilled to name),
        # so scan dedup re-attaches metrics instead of spawning a shadow row.
        assert merged["purchase:success"].source_name == "purchase_success_raw"
        # create-new path carried the source_name across too.
        assert merged["signup:done"].source_name == "signup_done_raw"


@pytest.mark.asyncio
async def test_deep_copy_carries_event_source_name_so_merge_preserves_it(
    client: AsyncClient,
) -> None:
    """Deep-copy must carry an event's ``source_name`` onto the branch copy.

    If the deep-copy left the branch event's ``source_name`` as ``None`` and no
    scan re-stamped it, merge's update-existing path would copy that ``None``
    back over main's good value — re-introducing the orphaned-metrics/shadow-row
    bug. Here the branch event's ``source_name`` is deliberately NOT touched after
    branch creation (no scan), so the only way main keeps its value is if the
    deep-copy carried it.
    """
    await _seed_plan(client, "merge-deepcopy-srcname")

    main_branch_id_str = None
    async with TestSessionLocal() as session:
        main_branch = (
            (await session.execute(select(PlanBranch).where(PlanBranch.name == "main")))
            .scalars()
            .first()
        )
        main_branch_id_str = main_branch.id
        main_event = (
            (
                await session.execute(
                    select(Event).where(
                        Event.branch_id == main_branch.id,
                        Event.name == "purchase:success",
                    )
                )
            )
            .scalars()
            .first()
        )
        main_event.source_name = "purchase_success_raw"
        await session.commit()

    branch_id = await _create_branch(client, "merge-deepcopy-srcname")
    branch_uuid = uuid.UUID(branch_id)

    # The deep-copy must have carried source_name onto the branch event copy.
    async with TestSessionLocal() as session:
        branch_event = (
            (
                await session.execute(
                    select(Event).where(
                        Event.branch_id == branch_uuid,
                        Event.name == "purchase:success",
                    )
                )
            )
            .scalars()
            .first()
        )
        assert branch_event.source_name == "purchase_success_raw"
        # Mutate something unrelated so the merge hits the update-existing path
        # without re-stamping source_name (i.e. as if no scan ran on the branch).
        branch_event.description = "edited on branch"
        await session.commit()

    resp = await _approve_and_merge(client, "merge-deepcopy-srcname", branch_id)
    assert resp.status_code == 200, resp.text

    async with TestSessionLocal() as session:
        merged_main_event = (
            (
                await session.execute(
                    select(Event).where(
                        Event.branch_id == main_branch_id_str,
                        Event.name == "purchase:success",
                    )
                )
            )
            .scalars()
            .first()
        )
        # Merge must not have written None over main's good source_name.
        assert merged_main_event.source_name == "purchase_success_raw"
