"""Non-owners must not read warehouse connection metadata (tripl-jfm3.79).

``GET /api/v1/data-sources`` used to hand every authenticated user — viewers
included — the host, port, database, username, stored-secret flag, TLS material
and last driver error of every warehouse. Data sources are owner-managed, so the
read side is narrowed to the identity fields the scan and metric surfaces
actually render.
"""

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from tripl.main import app

PASSWORD = "Password123!"

# Everything a non-owner keeps: enough to say *which* warehouse a scan or metric
# points at and whether it is healthy.
VISIBLE_FIELDS = {
    "id",
    "project_id",
    "name",
    "db_type",
    "is_synthetic",
    "last_test_at",
    "last_test_status",
    "created_at",
    "updated_at",
}
# Everything that describes how to *reach* the warehouse.
REDACTED = {
    "host": "",
    "port": 0,
    "database_name": "",
    "username": "",
    "password_set": False,
    "timeout_seconds": None,
    "json_path_discovery": None,
    "last_test_message": None,
}


def _new_client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest_asyncio.fixture
async def stand():
    """An owner with a real-looking data source, plus an editor and a viewer."""
    owner = _new_client()
    editor = _new_client()
    viewer = _new_client()

    for client, email, name in (
        (owner, "ds-owner@example.com", "Owner"),
        (editor, "ds-editor@example.com", "Editor"),
        (viewer, "ds-viewer@example.com", "Viewer"),
    ):
        resp = await client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": PASSWORD, "name": name},
        )
        assert resp.status_code == 201, resp.text
        if client is viewer:
            viewer_id = resp.json()["id"]

    demote = await owner.patch(f"/api/v1/users/{viewer_id}", json={"role": "viewer"})
    assert demote.status_code == 200, demote.text
    relogin = await viewer.post(
        "/api/v1/auth/login", json={"email": "ds-viewer@example.com", "password": PASSWORD}
    )
    assert relogin.status_code == 200, relogin.text

    created = await owner.post(
        "/api/v1/data-sources",
        json={
            "name": "prod-clickhouse",
            "db_type": "clickhouse",
            "host": "clickhouse.internal.example.com",
            "port": 9440,
            "database_name": "analytics",
            "username": "tripl_ro",
            "password": "hunter2",
            "timeout_seconds": 90,
        },
    )
    assert created.status_code == 201, created.text

    yield owner, editor, viewer, created.json()["id"]

    for client in (owner, editor, viewer):
        await client.aclose()


@pytest.mark.asyncio
async def test_owner_still_sees_the_full_connection(stand) -> None:
    owner, _editor, _viewer, ds_id = stand

    listing = await owner.get("/api/v1/data-sources")
    assert listing.status_code == 200, listing.text
    (row,) = listing.json()
    assert row["host"] == "clickhouse.internal.example.com"
    assert row["port"] == 9440
    assert row["database_name"] == "analytics"
    assert row["username"] == "tripl_ro"
    assert row["password_set"] is True

    detail = await owner.get(f"/api/v1/data-sources/{ds_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["host"] == "clickhouse.internal.example.com"


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", ["editor", "viewer"])
async def test_non_owners_get_the_connection_redacted(stand, actor: str) -> None:
    owner, editor, viewer, ds_id = stand
    del owner
    client = editor if actor == "editor" else viewer

    for resp in (
        await client.get("/api/v1/data-sources"),
        await client.get(f"/api/v1/data-sources/{ds_id}"),
    ):
        assert resp.status_code == 200, resp.text
        payload = resp.json()
        row = payload[0] if isinstance(payload, list) else payload

        for field, blank in REDACTED.items():
            assert row[field] == blank, f"{actor} can still read {field}: {row[field]!r}"
        assert row["connection_settings"] == {
            "location": None,
            "maximum_bytes_billed": None,
            "dataset_allowlist": None,
            "sslmode": None,
            "sslrootcert": None,
            "sslcert": None,
            "search_path": None,
            "sslkey_set": False,
        }
        # No hostname or credential leaks anywhere else in the payload.
        assert "internal.example.com" not in resp.text
        assert "tripl_ro" not in resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize("actor", ["editor", "viewer"])
async def test_non_owners_keep_what_the_scan_and_metric_forms_need(stand, actor: str) -> None:
    """Redaction must not break picking a source or choosing a SQL dialect."""
    owner, editor, viewer, ds_id = stand
    del owner
    client = editor if actor == "editor" else viewer

    listing = await client.get("/api/v1/data-sources")
    assert listing.status_code == 200, listing.text
    (row,) = listing.json()

    assert row["id"] == ds_id
    assert row["name"] == "prod-clickhouse"
    assert row["db_type"] == "clickhouse"
    assert row["is_synthetic"] is False
    assert row["project_id"] is None
    assert set(row) >= VISIBLE_FIELDS


@pytest.mark.asyncio
async def test_redaction_does_not_poison_the_shared_list_cache(stand) -> None:
    """The service caches the full list; redaction happens per request, not in cache."""
    owner, editor, _viewer, _ds_id = stand

    first = await editor.get("/api/v1/data-sources")
    assert first.json()[0]["host"] == ""

    after = await owner.get("/api/v1/data-sources")
    assert after.json()[0]["host"] == "clickhouse.internal.example.com"
