"""Legacy-demo classification, upgrade, and orphan cleanup (epic tripl-2su6.10).

A "legacy demo" predates the generated-demo epic: an ordinary project wired to a
``Demo warehouse <slug>`` clickhouse source at host ``demo.internal`` with no
``is_demo`` flag. Classification is a STRICT CONJUNCTION — a ``demo-*`` slug or a
"demo"-ish name alone must NEVER classify a real project as legacy.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.data_source import DataSource
from tripl.models.event import Event
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.services import demo_legacy_service, plan_branch_service
from tripl.services.demo import DEMO_RECIPE_VERSION
from tripl.tests.conftest import TestSessionLocal


async def _make_project(session: AsyncSession, *, slug: str, is_demo: bool = False) -> Project:
    project = Project(name=slug, slug=slug, description="", is_demo=is_demo)
    session.add(project)
    await session.flush()
    await plan_branch_service.ensure_main_branch_id(session, project.id)
    await session.commit()
    return project


async def _add_source(
    session: AsyncSession,
    *,
    name: str,
    host: str,
    db_type: str = "clickhouse",
    project_id: uuid.UUID | None = None,
    referencing_project: uuid.UUID | None = None,
) -> DataSource:
    ds = DataSource(
        name=name,
        host=host,
        db_type=db_type,
        port=8123,
        database_name="analytics",
        project_id=project_id,
    )
    session.add(ds)
    await session.flush()
    if referencing_project is not None:
        session.add(
            ScanConfig(
                data_source_id=ds.id,
                project_id=referencing_project,
                name=f"scan-{name}",
                base_query="SELECT 1",
            )
        )
    await session.commit()
    return ds


# ── Classification: positive ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_legacy_demo_is_classified_and_flagged(client: AsyncClient) -> None:
    async with TestSessionLocal() as session:
        project = await _make_project(session, slug="legacy-1")
        await _add_source(
            session,
            name="Demo warehouse legacy-1",
            host="demo.internal",
            referencing_project=project.id,
        )
        assert await demo_legacy_service.classify_project(session, project) == (
            demo_legacy_service.CLASS_LEGACY
        )

    resp = await client.get("/api/v1/projects/legacy-1")
    assert resp.status_code == 200
    body = resp.json()
    assert body["demo_legacy"] is True
    assert body["demo_outdated"] is False


# ── Classification: negatives (strict conjunction) ──────────────────────────


@pytest.mark.asyncio
async def test_real_project_with_demo_like_slug_is_not_legacy(client: AsyncClient) -> None:
    # A real project a user happens to slug like a demo, backed by a REAL
    # warehouse, must classify as real — slug alone is never a marker.
    async with TestSessionLocal() as session:
        project = await _make_project(session, slug="demo-analytics")
        await _add_source(
            session,
            name="Prod warehouse",
            host="warehouse.example.com",
            referencing_project=project.id,
        )
        assert await demo_legacy_service.classify_project(session, project) == (
            demo_legacy_service.CLASS_REAL
        )

    body = (await client.get("/api/v1/projects/demo-analytics")).json()
    assert body["demo_legacy"] is False


@pytest.mark.asyncio
async def test_demo_named_source_with_wrong_host_is_not_legacy() -> None:
    # The name pattern matches, but a real host breaks the conjunction → real.
    async with TestSessionLocal() as session:
        project = await _make_project(session, slug="pseudo-demo")
        await _add_source(
            session,
            name="Demo warehouse pseudo-demo",
            host="real.example.com",
            referencing_project=project.id,
        )
        assert await demo_legacy_service.classify_project(session, project) == (
            demo_legacy_service.CLASS_REAL
        )


@pytest.mark.asyncio
async def test_current_demo_is_neither_legacy_nor_outdated(client: AsyncClient) -> None:
    slug = (await client.post("/api/v1/projects/demo")).json()["slug"]
    body = (await client.get(f"/api/v1/projects/{slug}")).json()
    assert body["is_demo"] is True
    assert body["demo_legacy"] is False
    assert body["demo_outdated"] is False
    async with TestSessionLocal() as session:
        project = (
            await session.execute(select(Project).where(Project.slug == slug))
        ).scalar_one()
        assert await demo_legacy_service.classify_project(session, project) == (
            demo_legacy_service.CLASS_CURRENT_DEMO
        )


@pytest.mark.asyncio
async def test_outdated_demo_is_flagged(client: AsyncClient) -> None:
    slug = (await client.post("/api/v1/projects/demo")).json()["slug"]
    # Age the recipe: pretend it was seeded by an older recipe than the current.
    async with TestSessionLocal() as session:
        await session.execute(
            update(Project).where(Project.slug == slug).values(demo_recipe_version="1")
        )
        await session.commit()

    body = (await client.get(f"/api/v1/projects/{slug}")).json()
    assert body["demo_outdated"] is True


# ── Upgrade ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upgrade_outdated_demo_to_current_recipe(client: AsyncClient) -> None:
    slug = (await client.post("/api/v1/projects/demo")).json()["slug"]
    async with TestSessionLocal() as session:
        await session.execute(
            update(Project).where(Project.slug == slug).values(demo_recipe_version="1")
        )
        await session.commit()

    resp = await client.post(f"/api/v1/projects/demo/{slug}/upgrade")
    assert resp.status_code == 200
    body = resp.json()
    assert body["demo_recipe_version"] == DEMO_RECIPE_VERSION
    assert body["demo_outdated"] is False


@pytest.mark.asyncio
async def test_upgrade_real_project_is_404(client: AsyncClient) -> None:
    await client.post(
        "/api/v1/projects", json={"name": "Real", "slug": "real-1", "description": ""}
    )
    resp = await client.post("/api/v1/projects/demo/real-1/upgrade")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_upgrade_current_demo_is_409(client: AsyncClient) -> None:
    slug = (await client.post("/api/v1/projects/demo")).json()["slug"]
    resp = await client.post(f"/api/v1/projects/demo/{slug}/upgrade")
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_upgrade_preserves_edited_demo_without_force(client: AsyncClient) -> None:
    slug = (await client.post("/api/v1/projects/demo")).json()["slug"]
    async with TestSessionLocal() as session:
        project = (
            await session.execute(select(Project).where(Project.slug == slug))
        ).scalar_one()
        # Mark outdated so it is upgradable, and simulate a user edit well past the
        # seed anchor (a Core UPDATE bypasses the onupdate=now() so the future
        # timestamp sticks).
        await session.execute(
            update(Project).where(Project.id == project.id).values(demo_recipe_version="1")
        )
        anchor = (
            await session.execute(
                select(Event.created_at).where(Event.project_id == project.id).limit(1)
            )
        ).scalar_one()
        future = anchor.replace(year=anchor.year + 1)
        await session.execute(
            update(Event)
            .where(Event.project_id == project.id)
            .values(updated_at=future)
        )
        await session.commit()

    refused = await client.post(f"/api/v1/projects/demo/{slug}/upgrade")
    assert refused.status_code == 409

    forced = await client.post(f"/api/v1/projects/demo/{slug}/upgrade?force=true")
    assert forced.status_code == 200
    assert forced.json()["demo_recipe_version"] == DEMO_RECIPE_VERSION


@pytest.mark.asyncio
async def test_upgrade_legacy_demo_adopts_and_reseeds(client: AsyncClient) -> None:
    async with TestSessionLocal() as session:
        project = await _make_project(session, slug="legacy-up")
        await _add_source(
            session,
            name="Demo warehouse legacy-up",
            host="demo.internal",
            referencing_project=project.id,
        )

    resp = await client.post("/api/v1/projects/demo/legacy-up/upgrade")
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_demo"] is True
    assert body["demo_recipe_version"] == DEMO_RECIPE_VERSION
    assert body["demo_legacy"] is False

    # The old legacy clickhouse source is gone; the demo now owns a synthetic one.
    async with TestSessionLocal() as session:
        legacy = (
            await session.execute(
                select(DataSource).where(
                    DataSource.host == "demo.internal",
                    DataSource.name.like("Demo warehouse legacy-up%"),
                )
            )
        ).scalars().all()
        assert legacy == []


# ── Orphan cleanup ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cleanup_removes_only_proven_orphan_legacy_sources() -> None:
    async with TestSessionLocal() as session:
        # Orphan: legacy signature, project_id NULL, no scan config → removable.
        orphan = await _add_source(
            session, name="Demo warehouse orphan", host="demo.internal"
        )
        # Referenced legacy source: still wired to a project → left alone.
        referenced_project = await _make_project(session, slug="ref-legacy")
        await _add_source(
            session,
            name="Demo warehouse ref",
            host="demo.internal",
            referencing_project=referenced_project.id,
        )
        # A real source → never touched.
        real = await _add_source(
            session, name="Prod warehouse real", host="warehouse.example.com"
        )

        removed = await demo_legacy_service.cleanup_orphan_legacy_sources(session)
        assert removed == 1

    async with TestSessionLocal() as session:
        assert (await session.get(DataSource, orphan.id)) is None
        assert (await session.get(DataSource, real.id)) is not None
        still_referenced = (
            await session.execute(
                select(DataSource).where(DataSource.name == "Demo warehouse ref")
            )
        ).scalar_one_or_none()
        assert still_referenced is not None
