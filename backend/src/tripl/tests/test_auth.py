import pytest
from httpx import AsyncClient

from tripl.services import auth_service
from tripl.tests.conftest import TestSessionLocal


@pytest.mark.asyncio
async def test_register_creates_user_and_session_cookie(anon_client: AsyncClient):
    response = await anon_client.post(
        "/api/v1/auth/register",
        json={
            "email": "owner@example.com",
            "password": "Password123!",
            "name": "Owner",
        },
    )

    assert response.status_code == 201
    assert response.json()["email"] == "owner@example.com"
    assert "tripl_session=" in response.headers["set-cookie"]


@pytest.mark.asyncio
async def test_register_rejects_weak_password(anon_client: AsyncClient):
    # Under the unified policy a register password must be >= 12 chars with a
    # number and a symbol; "password" (8 chars, no digit, no symbol) is rejected
    # at the schema boundary before any user is stored.
    response = await anon_client.post(
        "/api/v1/auth/register",
        json={
            "email": "weak@example.com",
            "password": "password",
        },
    )

    assert response.status_code == 422
    body = response.json()
    assert any("password" in error.get("loc", []) for error in body["detail"])


@pytest.mark.asyncio
async def test_status_reports_empty_instance_then_populated(anon_client: AsyncClient):
    fresh = await anon_client.get("/api/v1/auth/status")
    assert fresh.status_code == 200
    assert fresh.json() == {"has_users": False}

    register = await anon_client.post(
        "/api/v1/auth/register",
        json={
            "email": "owner@example.com",
            "password": "Password123!",
        },
    )
    assert register.status_code == 201

    populated = await anon_client.get("/api/v1/auth/status")
    assert populated.status_code == 200
    assert populated.json() == {"has_users": True}


@pytest.mark.asyncio
async def test_first_owner_lock_is_noop_off_postgres():
    # The first-owner TOCTOU guard is a constant-key pg_advisory_xact_lock taken
    # before the has_any_users() check; PostgreSQL serialises concurrent first
    # registrations there. On SQLite (this suite) the helper must be a silent
    # no-op — it must not emit SQL the dialect can't parse or raise. The
    # behavioural race itself is untestable here: the suite runs on a single
    # in-memory connection, so two registrations can never interleave.
    async with TestSessionLocal() as session:
        await auth_service._acquire_first_owner_xact_lock(session)


@pytest.mark.asyncio
async def test_login_returns_cookie_and_me(anon_client: AsyncClient):
    await anon_client.post(
        "/api/v1/auth/register",
        json={
            "email": "owner@example.com",
            "password": "Password123!",
        },
    )

    login_response = await anon_client.post(
        "/api/v1/auth/login",
        json={
            "email": "OWNER@example.com",
            "password": "Password123!",
        },
    )

    assert login_response.status_code == 200

    me_response = await anon_client.get("/api/v1/auth/me")
    assert me_response.status_code == 200
    assert me_response.json()["email"] == "owner@example.com"


@pytest.mark.asyncio
async def test_protected_route_requires_auth(anon_client: AsyncClient):
    response = await anon_client.get("/api/v1/projects")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_logout_clears_cookie_and_blocks_follow_up_request(client: AsyncClient):
    logout_response = await client.post("/api/v1/auth/logout")
    assert logout_response.status_code == 204

    me_response = await client.get("/api/v1/auth/me")
    assert me_response.status_code == 401
