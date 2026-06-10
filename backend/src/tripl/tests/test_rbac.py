from collections.abc import AsyncGenerator

import pytest
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient

from tripl.api.deps import get_editor_user, get_owner_user, get_write_user
from tripl.main import app


@pytest.fixture
async def fresh_anon_client() -> AsyncGenerator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _register(ac: AsyncClient, email: str) -> AsyncClient:
    resp = await ac.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Password123!", "name": email},
    )
    assert resp.status_code == 201, resp.text
    return ac


async def _set_role(owner_client: AsyncClient, target_email: str, role: str) -> None:
    users = await owner_client.get("/api/v1/users")
    assert users.status_code == 200
    target = next(u for u in users.json() if u["email"] == target_email)
    resp = await owner_client.patch(f"/api/v1/users/{target['id']}", json={"role": role})
    assert resp.status_code == 200, resp.text


def test_mutating_routes_require_write_gate() -> None:
    """Every mutating API route needs a write-scope dependency unless it is
    intentionally read-like or an auth endpoint."""
    allowed_without_write_gate = {
        "/api/v1/auth/register",
        "/api/v1/auth/login",
        "/api/v1/auth/logout",
        "/api/v1/projects/{slug}/events/window-metrics",
        "/api/v1/projects/{slug}/anomalies/signals/query",
        "/api/v1/projects/{slug}/alert-destinations/{destination_id}/rules/{rule_id}/simulate",
    }
    write_gates = {get_write_user, get_editor_user, get_owner_user}
    offenders: list[str] = []

    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        mutating_methods = (route.methods or set()) & {"POST", "PATCH", "PUT", "DELETE"}
        if not mutating_methods or not route.path.startswith("/api/v1"):
            continue
        if route.path in allowed_without_write_gate:
            continue
        dependency_calls = {dependency.call for dependency in route.dependant.dependencies}
        if dependency_calls.isdisjoint(write_gates):
            offenders.append(f"{','.join(sorted(mutating_methods))} {route.path}")

    assert offenders == []


@pytest.mark.asyncio
async def test_first_user_becomes_owner_subsequent_users_are_editors(
    fresh_anon_client: AsyncClient,
) -> None:
    await _register(fresh_anon_client, "first@example.com")
    me = await fresh_anon_client.get("/api/v1/auth/me")
    assert me.json()["role"] == "owner"

    # Clear the owner session and register a second user → defaults to editor.
    await fresh_anon_client.post("/api/v1/auth/logout")
    await _register(fresh_anon_client, "second@example.com")
    me2 = await fresh_anon_client.get("/api/v1/auth/me")
    assert me2.json()["role"] == "editor"


@pytest.mark.asyncio
async def test_viewer_cannot_mutate_but_can_read(fresh_anon_client: AsyncClient) -> None:
    # Owner registers and creates a project + viewer user.
    await _register(fresh_anon_client, "owner@example.com")
    await fresh_anon_client.post("/api/v1/projects", json={"name": "RBAC", "slug": "rbac-proj"})

    await fresh_anon_client.post("/api/v1/auth/logout")
    await _register(fresh_anon_client, "viewer@example.com")

    # Owner promotes viewer to viewer role.
    await fresh_anon_client.post("/api/v1/auth/logout")
    await fresh_anon_client.post(
        "/api/v1/auth/login",
        json={"email": "owner@example.com", "password": "Password123!"},
    )
    await _set_role(fresh_anon_client, "viewer@example.com", "viewer")

    # Now sign in as viewer.
    await fresh_anon_client.post("/api/v1/auth/logout")
    await fresh_anon_client.post(
        "/api/v1/auth/login",
        json={"email": "viewer@example.com", "password": "Password123!"},
    )

    # Reads work.
    listing = await fresh_anon_client.get("/api/v1/projects")
    assert listing.status_code == 200

    # Mutations are rejected with 403.
    create = await fresh_anon_client.post(
        "/api/v1/projects", json={"name": "Blocked", "slug": "blocked"}
    )
    assert create.status_code == 403

    create_et = await fresh_anon_client.post(
        "/api/v1/projects/rbac-proj/event-types",
        json={"name": "x", "display_name": "X"},
    )
    assert create_et.status_code == 403


@pytest.mark.asyncio
async def test_only_owner_can_change_roles(fresh_anon_client: AsyncClient) -> None:
    await _register(fresh_anon_client, "owner2@example.com")
    await fresh_anon_client.post("/api/v1/auth/logout")
    await _register(fresh_anon_client, "editor2@example.com")
    # Editor tries to change owner's role.
    users = await fresh_anon_client.get("/api/v1/users")
    owner = next(u for u in users.json() if u["email"] == "owner2@example.com")
    resp = await fresh_anon_client.patch(f"/api/v1/users/{owner['id']}", json={"role": "viewer"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_role_change_invalidates_existing_sessions(
    fresh_anon_client: AsyncClient,
) -> None:
    # Owner registers, then an editor registers and stays signed in.
    await _register(fresh_anon_client, "owner3@example.com")
    await fresh_anon_client.post("/api/v1/auth/logout")
    await _register(fresh_anon_client, "demoted@example.com")

    # The editor's active session can mutate before the downgrade.
    create = await fresh_anon_client.post(
        "/api/v1/projects", json={"name": "Before", "slug": "before-demote"}
    )
    assert create.status_code == 201, create.text

    # Capture the editor's still-active session cookie before the owner acts.
    editor_cookies = dict(fresh_anon_client.cookies)

    # Owner demotes the editor to viewer in a separate client.
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as owner_client:
        await owner_client.post(
            "/api/v1/auth/login",
            json={"email": "owner3@example.com", "password": "Password123!"},
        )
        await _set_role(owner_client, "demoted@example.com", "viewer")

    # The previously captured editor session must no longer authenticate,
    # proving the session rows were deleted on role change.
    transport2 = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport2, base_url="http://test", cookies=editor_cookies
    ) as stale_client:
        me = await stale_client.get("/api/v1/auth/me")
        assert me.status_code == 401, me.text


@pytest.mark.asyncio
async def test_cannot_demote_last_owner(fresh_anon_client: AsyncClient) -> None:
    await _register(fresh_anon_client, "lone-owner@example.com")
    me = (await fresh_anon_client.get("/api/v1/auth/me")).json()
    resp = await fresh_anon_client.patch(f"/api/v1/users/{me['id']}", json={"role": "editor"})
    assert resp.status_code == 400
    assert "last remaining owner" in resp.json()["detail"]
