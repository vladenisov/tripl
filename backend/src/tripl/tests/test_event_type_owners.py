"""Per-event-type stakeholder ownership: CRUD + merge gating.

Owners are attached to live (main) event types and gate plan-branch merges:
a branch that touches an owned event type requires an approval from at least
one owner. Unowned event types auto-pass — gating only kicks in once someone
takes ownership.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tripl.models.event_type import EventType
from tripl.models.user import User
from tripl.tests.conftest import TestSessionLocal


async def _seed_project_with_type(client: AsyncClient, slug: str) -> tuple[str, str]:
    """Returns (event_type_id, project_slug). Test user is auto-authenticated."""
    await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    et_resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "track", "display_name": "Track"},
    )
    return et_resp.json()["id"], slug


async def _seed_second_user(email: str = "other@example.com") -> uuid.UUID:
    """Insert a second user directly via the test session (no auth handshake)."""
    async with TestSessionLocal() as session:
        user = User(
            email=email,
            name="Other Person",
            password_hash="x",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user.id


@pytest.mark.asyncio
async def test_add_list_remove_owner(client: AsyncClient) -> None:
    et_id, slug = await _seed_project_with_type(client, "own-crud")
    second_user_id = await _seed_second_user()

    add = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/owners",
        json={"user_id": str(second_user_id)},
    )
    assert add.status_code == 201, add.text
    owner = add.json()
    assert owner["user_id"] == str(second_user_id)
    assert owner["user_email"] == "other@example.com"
    owner_id = owner["id"]

    listed = await client.get(f"/api/v1/projects/{slug}/event-types/{et_id}/owners")
    assert listed.status_code == 200
    rows = listed.json()
    assert len(rows) == 1
    assert rows[0]["user_email"] == "other@example.com"

    removed = await client.delete(f"/api/v1/projects/{slug}/event-types/{et_id}/owners/{owner_id}")
    assert removed.status_code == 204

    after = await client.get(f"/api/v1/projects/{slug}/event-types/{et_id}/owners")
    assert after.json() == []


@pytest.mark.asyncio
async def test_duplicate_owner_returns_409(client: AsyncClient) -> None:
    et_id, slug = await _seed_project_with_type(client, "own-dup")
    second_user_id = await _seed_second_user()

    first = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/owners",
        json={"user_id": str(second_user_id)},
    )
    assert first.status_code == 201

    dup = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/owners",
        json={"user_id": str(second_user_id)},
    )
    assert dup.status_code == 409


@pytest.mark.asyncio
async def test_owners_rejected_on_branch_event_type(client: AsyncClient) -> None:
    """Owners can be managed only on the live (main) event type."""
    _et_id, slug = await _seed_project_with_type(client, "own-branch")
    second_user_id = await _seed_second_user()

    branch_resp = await client.post(f"/api/v1/projects/{slug}/branches", json={"name": "feature-x"})
    assert branch_resp.status_code == 201
    branch_id = uuid.UUID(branch_resp.json()["id"])

    async with TestSessionLocal() as session:
        branch_et = (
            (await session.execute(select(EventType).where(EventType.branch_id == branch_id)))
            .scalars()
            .first()
        )
        assert branch_et is not None
        branch_et_id = branch_et.id

    resp = await client.post(
        f"/api/v1/projects/{slug}/event-types/{branch_et_id}/owners",
        json={"user_id": str(second_user_id)},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_merge_blocked_when_owner_did_not_approve(client: AsyncClient) -> None:
    """A branch that touches an owned event type can't merge without an owner's
    approval. Test user (who approves the branch) is NOT the owner, so the
    sole owner's missing approval blocks merge."""
    et_id, slug = await _seed_project_with_type(client, "own-merge-block")
    owner_user_id = await _seed_second_user("owner@example.com")
    add = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/owners",
        json={"user_id": str(owner_user_id)},
    )
    assert add.status_code == 201

    branch_resp = await client.post(
        f"/api/v1/projects/{slug}/branches", json={"name": "rename-color"}
    )
    branch_id = branch_resp.json()["id"]

    # Mutate the branch's event_type metadata via ORM (router-level branch param
    # is exercised elsewhere).
    async with TestSessionLocal() as session:
        branch_et = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.branch_id == uuid.UUID(branch_id),
                        EventType.name == "track",
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_et.color = "#ff00aa"
        await session.commit()

    # Approve as test user (NOT an owner) and try to merge.
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "submit"},
    )
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "approve"},
    )
    merge = await client.post(f"/api/v1/projects/{slug}/branches/{branch_id}/merge")
    assert merge.status_code == 409
    detail = merge.json()["detail"]
    assert "missing_owner_approvals" in detail
    missing = detail["missing_owner_approvals"]
    assert any(item["event_type"] == "track" for item in missing)


@pytest.mark.asyncio
async def test_merge_passes_when_owner_is_the_approver(client: AsyncClient) -> None:
    """Test user is the owner and the only approver — merge proceeds."""
    et_id, slug = await _seed_project_with_type(client, "own-merge-pass")

    async with TestSessionLocal() as session:
        test_user = (
            (await session.execute(select(User).where(User.email == "test@example.com")))
            .scalars()
            .first()
        )
        test_user_id = test_user.id

    add = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/owners",
        json={"user_id": str(test_user_id)},
    )
    assert add.status_code == 201

    branch_resp = await client.post(
        f"/api/v1/projects/{slug}/branches", json={"name": "owner-approves"}
    )
    branch_id = branch_resp.json()["id"]

    async with TestSessionLocal() as session:
        branch_et = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.branch_id == uuid.UUID(branch_id),
                        EventType.name == "track",
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_et.color = "#bb33cc"
        await session.commit()

    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "submit"},
    )
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "approve"},
    )
    merge = await client.post(f"/api/v1/projects/{slug}/branches/{branch_id}/merge")
    assert merge.status_code == 200, merge.text
    assert merge.json()["status"] == "merged"


async def _set_branch_et_color(branch_id: str, color: str) -> None:
    async with TestSessionLocal() as session:
        branch_et = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.branch_id == uuid.UUID(branch_id),
                        EventType.name == "track",
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_et.color = color
        await session.commit()


@pytest.mark.asyncio
async def test_owner_approval_goes_stale_after_content_edit(client: AsyncClient) -> None:
    """An owner's approval stops satisfying the owner gate once the branch
    content changes after the review (tripl-d8v6). min_approvals is zeroed so
    the owner gate — not the quota gate — is what blocks."""
    et_id, slug = await _seed_project_with_type(client, "own-merge-stale")
    zeroed = await client.patch(
        f"/api/v1/projects/{slug}/branch-settings", json={"min_approvals": 0}
    )
    assert zeroed.status_code == 200

    async with TestSessionLocal() as session:
        test_user = (
            (await session.execute(select(User).where(User.email == "test@example.com")))
            .scalars()
            .first()
        )
        test_user_id = test_user.id

    add = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et_id}/owners",
        json={"user_id": str(test_user_id)},
    )
    assert add.status_code == 201

    branch_resp = await client.post(
        f"/api/v1/projects/{slug}/branches", json={"name": "stale-owner-approval"}
    )
    branch_id = branch_resp.json()["id"]

    await _set_branch_et_color(branch_id, "#101010")
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "submit"},
    )
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "approve"},
    )

    # Post-approval edit: the recorded owner approval no longer matches.
    await _set_branch_et_color(branch_id, "#202020")

    merge = await client.post(f"/api/v1/projects/{slug}/branches/{branch_id}/merge")
    assert merge.status_code == 409
    assert "missing_owner_approvals" in merge.json()["detail"]

    # Re-approving restamps the hash; the merge then proceeds.
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "approve"},
    )
    merged = await client.post(f"/api/v1/projects/{slug}/branches/{branch_id}/merge")
    assert merged.status_code == 200, merged.text


@pytest.mark.asyncio
async def test_merge_passes_when_event_type_unowned(client: AsyncClient) -> None:
    """No owners on the touched event type ⇒ no gating ⇒ merge proceeds."""
    _et_id, slug = await _seed_project_with_type(client, "own-merge-skip")
    branch_resp = await client.post(f"/api/v1/projects/{slug}/branches", json={"name": "feature"})
    branch_id = branch_resp.json()["id"]

    async with TestSessionLocal() as session:
        branch_et = (
            (
                await session.execute(
                    select(EventType).where(
                        EventType.branch_id == uuid.UUID(branch_id),
                        EventType.name == "track",
                    )
                )
            )
            .scalars()
            .first()
        )
        branch_et.color = "#00bb88"
        await session.commit()

    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "submit"},
    )
    await client.post(
        f"/api/v1/projects/{slug}/branches/{branch_id}/transition",
        json={"action": "approve"},
    )
    merge = await client.post(f"/api/v1/projects/{slug}/branches/{branch_id}/merge")
    assert merge.status_code == 200, merge.text
