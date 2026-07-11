"""Demo project generator (orchestration only).

Creates a fully pre-populated project so users can explore the service without
connecting a warehouse. Every seeded row is synthetic — the DataSource never
receives a real query.

This module owns the two-phase, atomic provisioning transaction; the actual
seed shape lives in the versioned, declarative :mod:`tripl.services.demo`
scenario package (focused, independently-testable builders). ``DEMO_RECIPE_VERSION``
is re-exported here so existing callers keep importing it from ``demo_service``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.models.domain_enums import ProjectGenerationStatus
from tripl.models.project import Project
from tripl.schemas.project import ProjectResponse
from tripl.services import plan_branch_service, project_service
from tripl.services.demo import (
    DEMO_RECIPE_VERSION,
    DEMO_SEED,
    DemoContext,
    seed_demo_content,
)

__all__ = [
    "DEMO_RECIPE_VERSION",
    "create_demo_project",
    "reset_demo_project",
]


async def create_demo_project(
    session: AsyncSession,
    *,
    created_by: uuid.UUID | None = None,
    slug: str | None = None,
) -> ProjectResponse:
    """Provision a demo workspace atomically.

    Phase 1 commits a hidden, ``seeding`` project shell as the provisioning
    marker; phase 2 seeds all demo content and promotes it to ``ready``. A
    mid-seed failure rolls the partial seed back and marks the shell ``failed``
    (still hidden from normal project lists), so a partial or failed demo never
    surfaces as a real workspace. ``created_by`` records provenance so the
    creator can manage their own demo; ``slug`` lets ``reset`` re-seed in place.
    """
    now = datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)
    if slug is None:
        # Unique slug so repeated create calls never collide.
        slug = f"demo-{uuid.uuid4().hex[:6]}"

    # Phase 1: durable hidden shell, committed first as the provisioning marker.
    project = Project(
        name="Demo Project",
        slug=slug,
        description=(
            "A pre-populated demo workspace. "
            "Explore events, metrics, signals, and distribution drift "
            "without connecting a warehouse."
        ),
        is_demo=True,
        demo_recipe_version=DEMO_RECIPE_VERSION,
        generation_status=ProjectGenerationStatus.seeding.value,
        generation_stage="init",
        created_by_user_id=created_by,
    )
    session.add(project)
    await session.flush()
    project_id = project.id
    branch_id = await plan_branch_service.ensure_main_branch_id(session, project_id)
    await session.commit()
    await cache.delete_prefix(cache.prefix_projects())

    # Phase 2: seed all content, then promote to ready — or record a safe failure.
    try:
        await _seed_demo_content(
            session,
            project_id=project_id,
            branch_id=branch_id,
            slug=slug,
            now=now,
            created_by=created_by,
        )
    except Exception as exc:
        await session.rollback()
        failed = await session.get(Project, project_id)
        if failed is not None:
            failed.generation_status = ProjectGenerationStatus.failed.value
            failed.generation_stage = None
            failed.generation_error = _safe_generation_error(exc)
            await session.commit()
        await cache.delete_prefix(cache.prefix_projects())
        raise HTTPException(status_code=500, detail="Demo provisioning failed") from exc

    ready = await session.get(Project, project_id)
    if ready is not None:
        ready.generation_status = ProjectGenerationStatus.ready.value
        ready.generation_stage = None
        ready.generation_error = None
        ready.demo_seeded_at = now
    await session.commit()
    await cache.delete_prefix(cache.prefix_projects())
    await cache.delete_prefix(cache.prefix_data_sources())
    return await project_service.get_project(session, slug)


async def reset_demo_project(
    session: AsyncSession, slug: str, *, created_by: uuid.UUID | None = None
) -> ProjectResponse:
    """Restore a demo to its freshly-seeded state under the same slug.

    Delete removes the demo and its owned synthetic warehouse; recreate re-seeds
    under the same slug so the demo URL stays stable across a reset. The original
    creator is preserved so ownership-based management still applies afterwards.
    """
    project = await project_service.get_project_by_slug(session, slug)
    if not project.is_demo:
        raise HTTPException(status_code=400, detail="Only demo projects can be reset")
    creator = project.created_by_user_id or created_by
    await project_service.delete_project(session, slug)
    return await create_demo_project(session, created_by=creator, slug=slug)


def _safe_generation_error(exc: Exception) -> str:
    """Short, user-safe failure summary — never internals (SQL, secrets, trace)."""
    return f"Demo provisioning failed during seeding ({type(exc).__name__})."


async def _seed_demo_content(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str,
    now: datetime,
    created_by: uuid.UUID | None = None,
) -> None:
    """Thin wrapper: build the scenario context and run the ordered builders.

    Kept as a module-level attribute (not inlined) so provisioning tests can
    monkeypatch it. Does not commit — it runs inside the caller's phase-2
    transaction so a failure rolls back cleanly.
    """
    ctx = DemoContext(
        project_id=project_id,
        branch_id=branch_id,
        slug=slug,
        now=now,
        seed=DEMO_SEED,
        created_by=created_by,
    )
    await seed_demo_content(session, ctx)
