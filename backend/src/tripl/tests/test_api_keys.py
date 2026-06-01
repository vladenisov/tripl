"""CRUD + scope gating for user-issued API keys.

The fixture-authenticated client is the session-cookie path; once an API key
is issued, requests use ``Authorization: Bearer <token>`` and bypass cookies.
"""

import pytest
from httpx import AsyncClient


async def _issue_key(
    client: AsyncClient,
    *,
    name: str = "agent",
    scope: str = "read",
    expires_in_days: int | None = None,
) -> tuple[str, str]:
    payload: dict[str, object] = {"name": name, "scope": scope}
    if expires_in_days is not None:
        payload["expires_in_days"] = expires_in_days
    resp = await client.post("/api/v1/me/api-keys", json=payload)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    return body["id"], body["token"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_create_returns_raw_token_once_and_list_only_shows_prefix(
    anon_client: AsyncClient, client: AsyncClient
) -> None:
    """POST yields the raw token exactly once; subsequent listings expose
    only the prefix + metadata."""
    _key_id, token = await _issue_key(client, name="scripted-agent", scope="read")
    assert token.startswith("tk_r_")

    listing = await client.get("/api/v1/me/api-keys")
    assert listing.status_code == 200
    rows = listing.json()
    assert len(rows) == 1
    only = rows[0]
    assert only["name"] == "scripted-agent"
    assert only["scope"] == "read"
    assert only["revoked_at"] is None
    # No raw token leaked on GET — the prefix is non-secret and OK to display.
    assert "token" not in only
    assert only["key_prefix"].startswith("tk_r_")
    assert len(only["key_prefix"]) < len(token)


@pytest.mark.asyncio
async def test_read_key_can_call_get_endpoints(
    anon_client: AsyncClient, client: AsyncClient
) -> None:
    """A read-scope key authenticates GET endpoints without a session cookie."""
    await client.post("/api/v1/projects", json={"name": "P", "slug": "agent-read"})
    _key_id, token = await _issue_key(client, scope="read")

    resp = await anon_client.get("/api/v1/projects/agent-read/event-types", headers=_bearer(token))
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_read_key_cannot_call_write_endpoints(
    anon_client: AsyncClient, client: AsyncClient
) -> None:
    """A read-scope key is rejected (403) on editor surfaces."""
    await client.post("/api/v1/projects", json={"name": "P", "slug": "agent-block"})
    _key_id, token = await _issue_key(client, scope="read")

    resp = await anon_client.post(
        "/api/v1/projects/agent-block/event-types",
        json={"name": "track", "display_name": "Track"},
        headers=_bearer(token),
    )
    assert resp.status_code == 403
    assert "read-only" in resp.json()["detail"].lower()

    event_resp = await anon_client.post(
        "/api/v1/projects/agent-block/events",
        json={
            "event_type_id": "00000000-0000-0000-0000-000000000000",
            "name": "Blocked event",
        },
        headers=_bearer(token),
    )
    assert event_resp.status_code == 403

    scan_preview = await anon_client.post(
        "/api/v1/projects/agent-block/scans/preview",
        json={
            "data_source_id": "00000000-0000-0000-0000-000000000000",
            "base_query": "select 1",
        },
        headers=_bearer(token),
    )
    assert scan_preview.status_code == 403


@pytest.mark.asyncio
async def test_read_key_cannot_manage_api_keys(
    anon_client: AsyncClient, client: AsyncClient
) -> None:
    _key_id, token = await _issue_key(client, scope="read")

    create = await anon_client.post(
        "/api/v1/me/api-keys",
        json={"name": "escalate", "scope": "write"},
        headers=_bearer(token),
    )
    assert create.status_code == 403


@pytest.mark.asyncio
async def test_owner_read_key_cannot_update_roles(
    anon_client: AsyncClient, client: AsyncClient
) -> None:
    _key_id, token = await _issue_key(client, scope="read")
    users = await anon_client.get("/api/v1/users", headers=_bearer(token))
    assert users.status_code == 200
    owner_id = users.json()[0]["id"]

    update = await anon_client.patch(
        f"/api/v1/users/{owner_id}",
        json={"role": "editor"},
        headers=_bearer(token),
    )
    assert update.status_code == 403


@pytest.mark.asyncio
async def test_write_key_can_call_write_endpoints(
    anon_client: AsyncClient, client: AsyncClient
) -> None:
    """A write-scope key passes editor gating (subject to user role)."""
    await client.post("/api/v1/projects", json={"name": "P", "slug": "agent-write"})
    _key_id, token = await _issue_key(client, scope="write")

    resp = await anon_client.post(
        "/api/v1/projects/agent-write/event-types",
        json={"name": "checkout", "display_name": "Checkout"},
        headers=_bearer(token),
    )
    assert resp.status_code == 201
    assert resp.json()["name"] == "checkout"


@pytest.mark.asyncio
async def test_revoked_key_is_rejected(anon_client: AsyncClient, client: AsyncClient) -> None:
    key_id, token = await _issue_key(client, scope="read")
    revoke = await client.delete(f"/api/v1/me/api-keys/{key_id}")
    assert revoke.status_code == 204

    after = await anon_client.get("/api/v1/projects", headers=_bearer(token))
    assert after.status_code == 401


@pytest.mark.asyncio
async def test_invalid_bearer_returns_401(anon_client: AsyncClient) -> None:
    """A garbage bearer token must NOT silently fall back to anonymous —
    that would let an attacker probe for endpoints under fake auth."""
    resp = await anon_client.get(
        "/api/v1/projects", headers=_bearer("tk_r_definitely-not-a-real-key")
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_expires_in_days_validation(client: AsyncClient) -> None:
    """expires_in_days must be positive (or absent)."""
    bad = await client.post(
        "/api/v1/me/api-keys",
        json={"name": "k", "scope": "read", "expires_in_days": 0},
    )
    assert bad.status_code == 422

    good = await client.post(
        "/api/v1/me/api-keys",
        json={"name": "k", "scope": "read", "expires_in_days": 30},
    )
    assert good.status_code == 201
    assert good.json()["expires_at"] is not None


@pytest.mark.asyncio
async def test_user_cannot_revoke_another_users_key(
    anon_client: AsyncClient, client: AsyncClient
) -> None:
    """API keys are per-user — even a second account in the same instance
    can't see or revoke them."""
    key_id, _token = await _issue_key(client, scope="read")

    # Register a second user via the anon client and use it instead.
    register = await anon_client.post(
        "/api/v1/auth/register",
        json={
            "email": "other@example.com",
            "password": "Password123!",
            "name": "Other",
        },
    )
    assert register.status_code == 201

    revoke = await anon_client.delete(f"/api/v1/me/api-keys/{key_id}")
    assert revoke.status_code == 404
