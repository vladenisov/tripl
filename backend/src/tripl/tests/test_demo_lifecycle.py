"""Demo identity + atomic lifecycle (epic tripl-2su6.1).

Covers demo identity metadata, provisioning atomicity (a failed seed leaves no
visible demo), synthetic-DataSource ownership/cleanup, and reset-in-place. The
full owner/editor/viewer permission matrix and browser E2E live in tripl-2su6.10.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.data_source import DataSource
from tripl.models.event_type import EventType
from tripl.models.project import Project
from tripl.services import demo_service
from tripl.tests.conftest import TestSessionLocal


async def _project_for_slug(session: AsyncSession, slug: str) -> Project:
    return (await session.execute(select(Project).where(Project.slug == slug))).scalar_one()


@pytest.mark.asyncio
async def test_demo_has_explicit_identity(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    data = resp.json()

    # Identity is explicit metadata, not slug/host/name convention.
    assert data["is_demo"] is True
    assert data["generation_status"] == "ready"
    assert data["demo_recipe_version"] == demo_service.DEMO_RECIPE_VERSION
    assert data["demo_seeded_at"] is not None
    # Provenance: the owner who created it is recorded.
    assert data["created_by_user_id"] is not None


@pytest.mark.asyncio
async def test_demo_data_source_is_scoped_to_project(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    slug = resp.json()["slug"]

    async with TestSessionLocal() as session:
        project = await _project_for_slug(session, slug)
        sources = (
            await session.execute(select(DataSource).where(DataSource.project_id == project.id))
        ).scalars().all()

    # Exactly one synthetic warehouse, owned by (scoped to) this demo project.
    assert len(sources) == 1
    assert sources[0].project_id == project.id


@pytest.mark.asyncio
async def test_delete_removes_owned_source_and_spares_real_ones(client: AsyncClient) -> None:
    # A real, workspace-global data source (project_id IS NULL) must survive a
    # demo delete; only the demo's owned synthetic source is removed.
    real_source_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        session.add(
            DataSource(
                id=real_source_id,
                project_id=None,
                name="Real warehouse",
                db_type="clickhouse",
                host="real.example.com",
                port=8123,
                database_name="analytics",
            )
        )
        await session.commit()

    resp = await client.post("/api/v1/projects/demo")
    slug = resp.json()["slug"]

    del_resp = await client.delete(f"/api/v1/projects/demo/{slug}")
    assert del_resp.status_code == 204

    async with TestSessionLocal() as session:
        project = (
            await session.execute(select(Project).where(Project.slug == slug))
        ).scalar_one_or_none()
        assert project is None  # demo gone
        real = await session.get(DataSource, real_source_id)
        assert real is not None  # real workspace source untouched
        leaked = (
            await session.execute(select(DataSource).where(DataSource.name.like("Demo warehouse%")))
        ).scalars().all()
        assert leaked == []  # no orphaned synthetic warehouse


@pytest.mark.asyncio
async def test_injected_seed_failure_leaves_no_visible_demo(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("injected seed failure")

    monkeypatch.setattr(demo_service, "_seed_demo_content", _boom)

    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 500

    # The failed demo is hidden from the normal project list...
    list_resp = await client.get("/api/v1/projects")
    assert list_resp.status_code == 200
    assert all(not p["is_demo"] for p in list_resp.json())

    # ...its partial seed rolled back (no event types), and it is marked failed.
    async with TestSessionLocal() as session:
        demos = (
            await session.execute(select(Project).where(Project.is_demo.is_(True)))
        ).scalars().all()
        assert len(demos) == 1
        failed = demos[0]
        assert failed.generation_status == "failed"
        assert failed.generation_error  # safe, non-empty summary
        event_types = (
            await session.execute(
                select(EventType).where(EventType.project_id == failed.id)
            )
        ).scalars().all()
        assert event_types == []


@pytest.mark.asyncio
async def test_reset_reprovisions_in_place(client: AsyncClient) -> None:
    resp = await client.post("/api/v1/projects/demo")
    slug = resp.json()["slug"]
    original_creator = resp.json()["created_by_user_id"]

    reset_resp = await client.post(f"/api/v1/projects/demo/{slug}/reset")
    assert reset_resp.status_code == 200
    data = reset_resp.json()

    # Same slug (stable URL), still a ready demo, creator preserved.
    assert data["slug"] == slug
    assert data["is_demo"] is True
    assert data["generation_status"] == "ready"
    assert data["created_by_user_id"] == original_creator

    # Content is present again after the reset.
    events_resp = await client.get(f"/api/v1/projects/{slug}/events")
    items = events_resp.json()
    items = items["items"] if isinstance(items, dict) else items
    assert len(items) > 0


@pytest.mark.asyncio
async def test_reset_rejects_non_demo_project(client: AsyncClient) -> None:
    create = await client.post(
        "/api/v1/projects",
        json={"name": "Real", "slug": "real-proj", "description": ""},
    )
    assert create.status_code == 201
    reset = await client.post("/api/v1/projects/demo/real-proj/reset")
    assert reset.status_code == 404


@pytest.mark.asyncio
async def test_demo_lifecycle_requires_auth(anon_client: AsyncClient) -> None:
    assert (await anon_client.post("/api/v1/projects/demo")).status_code == 401
    assert (await anon_client.post("/api/v1/projects/demo/x/reset")).status_code == 401
    assert (await anon_client.delete("/api/v1/projects/demo/x")).status_code == 401
