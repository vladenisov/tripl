import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.plan_branch import PlanBranch
from tripl.tests.conftest import TestSessionLocal


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
