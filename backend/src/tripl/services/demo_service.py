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

import logging
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.middleware.request_id import current_request_id
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

logger = logging.getLogger(__name__)

# Stable log event names so demo provisioning/reset failures are greppable and
# alertable in aggregated logs regardless of the underlying exception type.
DEMO_PROVISION_FAILED_EVENT = "demo.provision.failed"
DEMO_RESET_FAILED_EVENT = "demo.reset.failed"


def _demo_clock() -> datetime:
    """The demo's seed instant, floored to the hour so series land on buckets."""
    return datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)


def _new_demo_project(*, slug: str, created_by: uuid.UUID | None) -> Project:
    """The demo's Project row, shared by create and reset so they cannot drift."""
    return Project(
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
    now = _demo_clock()
    if slug is None:
        # Unique slug so repeated create calls never collide.
        slug = f"demo-{uuid.uuid4().hex[:6]}"

    # Phase 1: durable hidden shell, committed first as the provisioning marker.
    project = _new_demo_project(slug=slug, created_by=created_by)
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
        # Diagnosable failure: a stable event name plus the full traceback, the
        # per-request id (so an operator can pivot straight from the user's
        # report), and the failing DB statement/constraint — none of which leaks
        # to the client, which still receives only a generic 500.
        logger.warning(
            "%s slug=%s request_id=%s error=%s detail=%s",
            DEMO_PROVISION_FAILED_EVENT,
            slug,
            current_request_id() or "-",
            type(exc).__name__,
            _db_failure_detail(exc),
            exc_info=exc,
        )
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
    """Restore a demo to its freshly-seeded state under the same slug, atomically.

    The old demo and its replacement live in ONE transaction: the existing rows
    are dropped, a fresh demo is seeded under the same slug, and only then is
    anything committed. If seeding fails the rollback puts the original demo back
    exactly as it was, so a transient error can never trade a working demo for a
    hidden failed shell (tripl-2su6.13).

    Re-seeding in place — rather than seeding a replacement elsewhere and swapping
    it in — is deliberate: the seed derives the synthetic warehouse's name and the
    search documents from the slug, so content seeded under a temporary slug would
    carry that temporary slug. The original creator is preserved so ownership-based
    management still applies afterwards.
    """
    project = await project_service.get_project_by_slug(session, slug)
    if not project.is_demo:
        raise HTTPException(status_code=400, detail="Only demo projects can be reset")
    creator = project.created_by_user_id or created_by
    now = _demo_clock()

    try:
        await project_service.purge_project_rows(session, project)
        replacement = _new_demo_project(slug=slug, created_by=creator)
        session.add(replacement)
        await session.flush()
        branch_id = await plan_branch_service.ensure_main_branch_id(session, replacement.id)
        await _seed_demo_content(
            session,
            project_id=replacement.id,
            branch_id=branch_id,
            slug=slug,
            now=now,
            created_by=creator,
        )
        replacement.generation_status = ProjectGenerationStatus.ready.value
        replacement.generation_stage = None
        replacement.generation_error = None
        replacement.demo_seeded_at = now
        await session.commit()
    except Exception as exc:
        logger.warning(
            "%s slug=%s request_id=%s error=%s detail=%s",
            DEMO_RESET_FAILED_EVENT,
            slug,
            current_request_id() or "-",
            type(exc).__name__,
            _db_failure_detail(exc),
            exc_info=exc,
        )
        await session.rollback()
        raise HTTPException(
            status_code=500,
            detail="Demo reset failed. Your existing demo workspace was left unchanged.",
        ) from exc

    await cache.delete_prefix(cache.prefix_projects())
    await cache.delete_prefix(cache.prefix_data_sources())
    return await project_service.get_project(session, slug)


def _safe_generation_error(exc: Exception) -> str:
    """Short, user-safe failure summary — never internals (SQL, secrets, trace)."""
    return f"Demo provisioning failed during seeding ({type(exc).__name__})."


def _db_failure_detail(exc: Exception) -> str:
    """Server-only diagnostics for a seed failure: the failing DB statement and,
    when present, the violated constraint.

    SQLAlchemy wraps the driver error on ``.orig``; asyncpg exposes the offending
    constraint via ``.orig.diag.constraint_name``. Falls back to the exception's
    own text for non-DB failures. Logged only — never returned to a client.
    """
    orig = getattr(exc, "orig", None)
    if orig is None:
        return str(exc)
    constraint = getattr(getattr(orig, "diag", None), "constraint_name", None)
    if constraint:
        return f"{orig} [constraint={constraint}]"
    return str(orig)


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
