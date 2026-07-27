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
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.middleware.request_id import current_request_id
from tripl.models.domain_enums import ProjectGenerationStatus
from tripl.models.project import Project
from tripl.schemas.project import DemoCancelResponse, ProjectResponse
from tripl.services import plan_branch_service, project_service
from tripl.services.demo import (
    DEMO_RECIPE_VERSION,
    DEMO_SEED,
    DemoContext,
    seed_demo_content,
)

__all__ = [
    "DEMO_RECIPE_VERSION",
    "MAX_DEMOS_PER_CREATOR",
    "create_demo_project",
    "request_demo_cancel",
    "reset_demo_project",
]

logger = logging.getLogger(__name__)

# Stable log event names so demo provisioning/reset failures are greppable and
# alertable in aggregated logs regardless of the underlying exception type.
DEMO_PROVISION_FAILED_EVENT = "demo.provision.failed"
DEMO_PROVISION_CANCELLED_EVENT = "demo.provision.cancelled"
DEMO_RESET_FAILED_EVENT = "demo.reset.failed"
DEMO_SHELL_SWEPT_EVENT = "demo.shell.swept"

# Cancellation handshake. The create is one long blocking request, so a client
# abort only kills the browser's read of the response — the server would happily
# finish and materialise a workspace the user explicitly abandoned (tripl-jfm3.12).
# `request_demo_cancel` instead flags the committed phase-1 shell with this stage
# from a SECOND request; phase 2 re-reads it before promoting and deletes itself
# if the flag is set. Writing a non-key column does not conflict with the FK
# row locks the in-flight seed holds, so the flag lands while seeding runs.
DEMO_CANCEL_REQUESTED_STAGE = "cancel_requested"

# How many live (seeding or ready) demos one creator may hold at once. Demos are
# synthetic workspaces that aggregate into the real workspace roll-ups, so an
# unbounded generator turns an exploratory click into permanent pollution
# (tripl-jfm3.14). Reset/delete are the intended way to get a fresh one.
MAX_DEMOS_PER_CREATOR = 3

# A `failed` shell is diagnostic residue: hidden from every list, holding its
# slug forever. Keep it long enough to investigate a report, then reclaim it.
FAILED_SHELL_RETENTION_DAYS = 7

# A shell still `seeding` after this long was abandoned mid-provision (the worker
# process died between the phase-1 commit and either promotion or the failure
# marker). Comfortably above the ~11 s the seed takes and the 90 s client bound,
# so an actively-seeding shell can never fall inside it.
STALLED_SEEDING_HOURS = 1


def _demo_clock() -> datetime:
    """The demo's seed instant, floored to the hour so series land on buckets."""
    return datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)


def _demo_project_name(existing_count: int) -> str:
    """Distinguishable name per demo, so N demos are not N identical cards.

    The first demo keeps the plain product name; later ones are numbered by how
    many the creator already holds (tripl-jfm3.14).
    """
    return "Demo Project" if existing_count <= 0 else f"Demo Project {existing_count + 1}"


def _new_demo_project(
    *, slug: str, created_by: uuid.UUID | None, name: str = "Demo Project"
) -> Project:
    """The demo's Project row, shared by create and reset so they cannot drift."""
    return Project(
        name=name,
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

    # Reclaim long-dead failed shells before minting another one. Failed shells
    # only ever appear on this path, so this is also the only path that needs to
    # sweep them — no extra scheduled job to keep alive (tripl-jfm3.17/.76).
    await _sweep_failed_demo_shells(session)

    live = await _count_live_demos(session, created_by)
    if created_by is not None and live >= MAX_DEMOS_PER_CREATOR:
        raise HTTPException(
            status_code=409,
            detail=(
                f"You already have {live} demo workspaces (the limit is "
                f"{MAX_DEMOS_PER_CREATOR}). Reset or delete one before generating another."
            ),
        )

    # Phase 1: durable hidden shell, committed first as the provisioning marker.
    project = _new_demo_project(slug=slug, created_by=created_by, name=_demo_project_name(live))
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

    # Cancellation is decided here, at the one atomic decision point: everything
    # seeded above is still uncommitted, so abandoning it costs a rollback and
    # the shell delete. The client has long since aborted its read, so the status
    # below is for logs and API clients, not for a human.
    if await _cancel_requested(session, project_id):
        await session.rollback()
        shell = await session.get(Project, project_id)
        if shell is not None:
            await project_service.purge_project_rows(session, shell)
            await session.commit()
        await cache.delete_prefix(cache.prefix_projects())
        await cache.delete_prefix(cache.prefix_data_sources())
        logger.info("%s slug=%s", DEMO_PROVISION_CANCELLED_EVENT, slug)
        raise HTTPException(status_code=409, detail="Demo provisioning was cancelled")

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


async def request_demo_cancel(
    session: AsyncSession, *, created_by: uuid.UUID | None = None
) -> DemoCancelResponse:
    """Ask this user's in-flight demo provision to abandon itself.

    Runs in its own (short) request while the create's long phase-2 transaction
    is still open: it flags the already-committed shell, and the create checks
    that flag before promoting. Returns ``cancelled=False`` when there is no
    seeding shell to flag — the create either already finished or never got far
    enough — so the caller can say so instead of implying a rollback that did
    not happen (tripl-jfm3.12).
    """
    if created_by is None:
        return DemoCancelResponse(cancelled=False, slug=None)

    in_flight = (
        (
            await session.execute(
                select(Project).where(
                    Project.is_demo.is_(True),
                    Project.generation_status == ProjectGenerationStatus.seeding.value,
                    Project.created_by_user_id == created_by,
                )
            )
        )
        .scalars()
        .all()
    )
    if not in_flight:
        return DemoCancelResponse(cancelled=False, slug=None)

    for shell in in_flight:
        shell.generation_stage = DEMO_CANCEL_REQUESTED_STAGE
    await session.commit()
    return DemoCancelResponse(cancelled=True, slug=in_flight[0].slug)


async def _cancel_requested(session: AsyncSession, project_id: uuid.UUID) -> bool:
    """Re-read the shell's stage from the database, bypassing the identity map.

    A column-only SELECT always emits SQL, so this sees the cancel committed by
    the other request; ``session.get`` could hand back a cached instance loaded
    before it.
    """
    stage = await session.scalar(select(Project.generation_stage).where(Project.id == project_id))
    return stage == DEMO_CANCEL_REQUESTED_STAGE


async def _count_live_demos(session: AsyncSession, created_by: uuid.UUID | None) -> int:
    """Demos this creator currently holds against their cap.

    Failed shells are residue, not demos. A shell abandoned mid-seed (the process
    died between the phase-1 commit and either promotion or the failure marker)
    is residue too — counting it would let a crash permanently consume a slot the
    user cannot see, let alone free.
    """
    if created_by is None:
        return 0
    stall_cutoff = datetime.now(tz=UTC) - timedelta(hours=STALLED_SEEDING_HOURS)
    rows = await session.scalars(
        select(Project.id).where(
            Project.is_demo.is_(True),
            Project.created_by_user_id == created_by,
            Project.generation_status != ProjectGenerationStatus.failed.value,
            (Project.generation_status != ProjectGenerationStatus.seeding.value)
            | (Project.created_at >= stall_cutoff),
        )
    )
    return len(rows.all())


async def _sweep_failed_demo_shells(session: AsyncSession) -> int:
    """Delete provisioning shells that will never become a workspace.

    Two kinds: ``failed`` shells past the retention window, and ``seeding`` shells
    long past any plausible in-flight provision (~11 s of work, 90 s client
    bound). The stall horizon is hours, so an actively-seeding shell is never in
    range. Committed separately from the create that triggered it, so a later
    seed failure can never resurrect the rows this reclaimed.
    """
    failed_cutoff = datetime.now(tz=UTC) - timedelta(days=FAILED_SHELL_RETENTION_DAYS)
    stall_cutoff = datetime.now(tz=UTC) - timedelta(hours=STALLED_SEEDING_HOURS)
    stale = (
        (
            await session.execute(
                select(Project).where(
                    Project.is_demo.is_(True),
                    (
                        (Project.generation_status == ProjectGenerationStatus.failed.value)
                        & (Project.created_at < failed_cutoff)
                    )
                    | (
                        (Project.generation_status == ProjectGenerationStatus.seeding.value)
                        & (Project.created_at < stall_cutoff)
                    ),
                )
            )
        )
        .scalars()
        .all()
    )
    if not stale:
        return 0
    for shell in stale:
        await project_service.purge_project_rows(session, shell)
    await session.commit()
    logger.info(
        "%s count=%d slugs=%s failed_cutoff=%s stalled_cutoff=%s",
        DEMO_SHELL_SWEPT_EVENT,
        len(stale),
        ",".join(shell.slug for shell in stale),
        failed_cutoff.isoformat(),
        stall_cutoff.isoformat(),
    )
    await cache.delete_prefix(cache.prefix_projects())
    return len(stale)


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
    # Captured before the purge: a reset refreshes the CONTENT, so the workspace
    # keeps the name it was listed under (demos are numbered per creator now).
    name = project.name
    now = _demo_clock()

    try:
        await project_service.purge_project_rows(session, project)
        replacement = _new_demo_project(slug=slug, created_by=creator, name=name)
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
