"""Project-scoped authorization for the per-project mutation surface (tripl-jfm3.19).

Roles are instance-wide, so before this the ``editor`` role meant "may rewrite the
tracking plan of every project on the instance" — including injecting content into
another user's demo. These tests pin the DENIED cases route by route, plus the
allowed cases that must keep working (a shared workspace project stays
collaborative, and a creator keeps control of what they made).
"""

from collections.abc import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from tripl.api.deps import get_editor_user, get_owner_user
from tripl.main import app
from tripl.models.project import Project
from tripl.tests.conftest import TestSessionLocal
from tripl.tests.test_rbac import READ_LIKE_MUTATING_PATHS, iter_api_routes

PASSWORD = "Password123!"


def _new_client() -> AsyncClient:
    """A client with its own cookie jar, so several roles can act interleaved."""
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _register(client: AsyncClient, email: str, name: str) -> dict:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": PASSWORD, "name": name},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _create_project(client: AsyncClient, slug: str) -> dict:
    resp = await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _mark_demo(slug: str) -> None:
    """Turn a real project into a demo without paying for demo seeding."""
    async with TestSessionLocal() as session:
        project = await session.scalar(select(Project).where(Project.slug == slug))
        assert project is not None
        project.is_demo = True
        await session.commit()


async def _clear_creator(slug: str) -> None:
    """Simulate a project that predates creator tracking."""
    async with TestSessionLocal() as session:
        project = await session.scalar(select(Project).where(Project.slug == slug))
        assert project is not None
        project.created_by_user_id = None
        await session.commit()


class Actors:
    """owner + two unrelated editors + a viewer, each with its own session."""

    def __init__(self) -> None:
        self.owner = _new_client()
        self.editor = _new_client()
        self.stranger = _new_client()
        self.viewer = _new_client()

    async def aclose(self) -> None:
        for client in (self.owner, self.editor, self.stranger, self.viewer):
            await client.aclose()


@pytest_asyncio.fixture
async def actors() -> AsyncGenerator[Actors]:
    people = Actors()
    # First registered user is the instance owner; everyone after defaults to editor.
    await _register(people.owner, "owner@example.com", "Owner")
    await _register(people.editor, "editor@example.com", "Editor")
    await _register(people.stranger, "stranger@example.com", "Stranger")
    viewer = await _register(people.viewer, "viewer@example.com", "Viewer")

    demote = await people.owner.patch(
        f"/api/v1/users/{viewer['id']}",
        json={"role": "viewer"},
    )
    assert demote.status_code == 200, demote.text
    # A role change invalidates the user's sessions, so log the viewer back in.
    relogin = await people.viewer.post(
        "/api/v1/auth/login",
        json={"email": "viewer@example.com", "password": PASSWORD},
    )
    assert relogin.status_code == 200, relogin.text

    yield people
    await people.aclose()


# One representative mutation per per-project router that carries the editor gate.
# (method, path suffix, json body)
MUTATION_ROUTES = [
    ("POST", "event-types", {"name": "pv", "display_name": "Page View"}),
    ("POST", "variables", {"name": "plan", "display_name": "Plan", "value_type": "string"}),
    ("POST", "meta-fields", {"name": "team", "label": "Team", "field_type": "string"}),
    ("POST", "annotations", {"bucket": "2026-01-01T00:00:00Z", "label": "deploy"}),
    ("POST", "branches", {"name": "feature-x"}),
    ("POST", "revisions", {"message": "snapshot"}),
    ("POST", "search/reindex", None),
    ("POST", "alert-destinations", {"name": "ops", "kind": "webhook", "config": {}}),
    ("PATCH", "anomaly-settings", {"enabled": False}),
]


async def _call(client: AsyncClient, method: str, slug: str, suffix: str, body: dict | None):
    url = f"/api/v1/projects/{slug}/{suffix}"
    if method == "POST":
        return await client.post(url, json=body if body is not None else {})
    return await client.patch(url, json=body or {})


def test_every_project_scoped_mutation_carries_a_project_gate() -> None:
    """A new ``/projects/{slug}/...`` mutation must not ship with an unscoped gate.

    ``get_editor_user`` and ``get_owner_user`` are the only two dependencies that
    resolve the path's project: the first runs
    :func:`require_project_mutation_access`, the second is instance-owner-only and
    therefore passes it by definition. A slug-scoped mutation wired to bare
    ``get_write_user`` (or to no gate at all) would reopen tripl-jfm3.19, so fail
    the build instead of waiting for the next audit.
    """
    project_gates = {get_editor_user, get_owner_user}
    offenders: list[str] = []

    for path, route in iter_api_routes():
        methods = (route.methods or set()) & {"POST", "PATCH", "PUT", "DELETE"}
        if not methods or "{slug}" not in path:
            continue
        if path in READ_LIKE_MUTATING_PATHS:
            continue
        calls = {dependency.call for dependency in route.dependant.dependencies}
        if calls.isdisjoint(project_gates):
            offenders.append(f"{','.join(sorted(methods))} {path}")

    assert offenders == []


@pytest.mark.asyncio
async def test_editor_cannot_mutate_a_project_another_editor_created(actors: Actors) -> None:
    """The headline vector: a self-registered editor vandalising someone else's project."""
    await _create_project(actors.editor, "editors-own")

    for method, suffix, body in MUTATION_ROUTES:
        denied = await _call(actors.stranger, method, "editors-own", suffix, body)
        assert denied.status_code == 403, f"{method} {suffix} -> {denied.status_code}"
        assert "project creator or an owner" in denied.json()["detail"]

    # The creator and the instance owner are both still allowed.
    allowed = await _call(
        actors.editor, "POST", "editors-own", "event-types", MUTATION_ROUTES[0][2]
    )
    assert allowed.status_code == 201, allowed.text
    owner_allowed = await actors.owner.post(
        "/api/v1/projects/editors-own/event-types",
        json={"name": "se", "display_name": "Session"},
    )
    assert owner_allowed.status_code == 201, owner_allowed.text


@pytest.mark.asyncio
async def test_editor_cannot_mutate_another_users_demo(actors: Actors) -> None:
    """Demo *content* now follows the same rule as demo reset/delete: creator or owner."""
    await _create_project(actors.owner, "owner-demo")
    await _mark_demo("owner-demo")

    for method, suffix, body in MUTATION_ROUTES:
        denied = await _call(actors.editor, method, "owner-demo", suffix, body)
        assert denied.status_code == 403, f"{method} {suffix} -> {denied.status_code}"
        assert "demo creator or an owner" in denied.json()["detail"]

    # The demo's creator (here the owner) keeps full control of its content.
    allowed = await actors.owner.post(
        "/api/v1/projects/owner-demo/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    assert allowed.status_code == 201, allowed.text


@pytest.mark.asyncio
async def test_editor_demo_is_closed_to_the_instance_owners_peers(actors: Actors) -> None:
    """A demo an editor made is theirs; another editor is out, the owner is in."""
    await _create_project(actors.editor, "editor-demo")
    await _mark_demo("editor-demo")

    denied = await actors.stranger.post(
        "/api/v1/projects/editor-demo/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    assert denied.status_code == 403, denied.text
    assert "demo creator or an owner" in denied.json()["detail"]

    creator_ok = await actors.editor.post(
        "/api/v1/projects/editor-demo/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    assert creator_ok.status_code == 201, creator_ok.text

    owner_ok = await actors.owner.post(
        "/api/v1/projects/editor-demo/event-types",
        json={"name": "se", "display_name": "Session"},
    )
    assert owner_ok.status_code == 201, owner_ok.text


@pytest.mark.asyncio
async def test_shared_workspace_projects_stay_collaborative(actors: Actors) -> None:
    """A real project an OWNER created is the team's plan — editors must keep editing it."""
    await _create_project(actors.owner, "team-plan")

    for client in (actors.editor, actors.stranger):
        resp = await client.post(
            "/api/v1/projects/team-plan/event-types",
            json={"name": f"pv-{id(client)}", "display_name": "Page View"},
        )
        assert resp.status_code == 201, resp.text


@pytest.mark.asyncio
async def test_projects_predating_creator_tracking_stay_collaborative(actors: Actors) -> None:
    """``created_by_user_id IS NULL`` rows are legacy shared plans, not private ones."""
    await _create_project(actors.editor, "legacy-plan")
    await _clear_creator("legacy-plan")

    resp = await actors.stranger.post(
        "/api/v1/projects/legacy-plan/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    assert resp.status_code == 201, resp.text


@pytest.mark.asyncio
async def test_viewer_is_denied_on_every_project_shape(actors: Actors) -> None:
    """The role gate still fires first, so a viewer never reaches the project gate."""
    await _create_project(actors.owner, "team-plan-v")
    await _create_project(actors.editor, "editors-own-v")

    for slug in ("team-plan-v", "editors-own-v"):
        denied = await actors.viewer.post(
            f"/api/v1/projects/{slug}/event-types",
            json={"name": "pv", "display_name": "Page View"},
        )
        assert denied.status_code == 403, denied.text
        assert denied.json()["detail"] == "Editor role required"


@pytest.mark.asyncio
async def test_reads_stay_open_to_every_authenticated_user(actors: Actors) -> None:
    """This is about who may MUTATE someone else's project — reads are unchanged."""
    await _create_project(actors.editor, "readable")
    await actors.editor.post(
        "/api/v1/projects/readable/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )

    for client in (actors.stranger, actors.viewer):
        listing = await client.get("/api/v1/projects/readable/event-types")
        assert listing.status_code == 200, listing.text
        assert [et["name"] for et in listing.json()] == ["pv"]

        detail = await client.get("/api/v1/projects/readable")
        assert detail.status_code == 200, detail.text


@pytest.mark.asyncio
async def test_project_identity_edits_stay_creator_or_owner(actors: Actors) -> None:
    """The looser content gate must not reopen PATCH /projects/{slug}."""
    await _create_project(actors.owner, "team-plan-p")

    denied = await actors.editor.patch(
        "/api/v1/projects/team-plan-p", json={"name": "Renamed by a stranger"}
    )
    assert denied.status_code == 403, denied.text
    assert "project creator or an owner can edit" in denied.json()["detail"]

    allowed = await actors.owner.patch("/api/v1/projects/team-plan-p", json={"name": "Renamed"})
    assert allowed.status_code == 200, allowed.text


@pytest.mark.asyncio
async def test_unknown_project_still_404s_for_a_denied_caller(actors: Actors) -> None:
    resp = await actors.stranger.post(
        "/api/v1/projects/no-such-project/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_api_key_inherits_its_owners_project_scope(actors: Actors) -> None:
    """An editor's API key is the editor — it cannot reach past the same fence."""
    await _create_project(actors.editor, "keyed-project")
    key_resp = await actors.stranger.post(
        "/api/v1/me/api-keys", json={"name": "agent", "scope": "write"}
    )
    assert key_resp.status_code == 201, key_resp.text
    token = key_resp.json()["token"]

    async with _new_client() as bearer:
        denied = await bearer.post(
            "/api/v1/projects/keyed-project/event-types",
            json={"name": "pv", "display_name": "Page View"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert denied.status_code == 403, denied.text
        assert "project creator or an owner" in denied.json()["detail"]
