"""Legacy-demo classification, in-place upgrade, and orphan-source cleanup.

Before the generated-demo epic, a "demo" was an ordinary project wired to a
DataSource named ``Demo warehouse <slug>`` with host ``demo.internal`` and
``db_type='clickhouse'`` — there was no ``is_demo`` flag and no recipe version.
Those are *legacy demos*. A modern demo is a first-class ``is_demo=True`` project
seeded by a versioned recipe; one seeded by an older recipe than the current is
*outdated*.

Classification is deliberately conservative:

* A project is **legacy ONLY** when ``is_demo`` is false/NULL **AND** it owns
  (``DataSource.project_id``) or references (via one of its ``ScanConfig`` rows) a
  DataSource that matches the FULL legacy signature — name ``LIKE 'Demo warehouse
  %'`` **AND** host ``== 'demo.internal'`` **AND** ``db_type == 'clickhouse'``.
  A ``demo-*`` slug, or a project/source whose *name* merely contains "demo", is
  NEVER sufficient: a real project a user happens to name/slug like a demo, but
  backed by a real warehouse, classifies as ``real``.
* A project is **outdated** when ``is_demo=True`` and its recipe version is older
  than :data:`tripl.services.demo.DEMO_RECIPE_VERSION`.

The current demo seeder uses a ``db_type='synthetic'`` source at host
``synthetic`` — it deliberately does NOT match the legacy signature, so a current
demo never classifies as legacy (and ``is_demo`` gates it first anyway).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import ColumnElement, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.models.data_source import DataSource, DBType
from tripl.models.event import Event
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.schemas.project import ProjectResponse
from tripl.services.demo import DEMO_RECIPE_VERSION

# ── Classification labels ──────────────────────────────────────────────────
CLASS_REAL = "real"
CLASS_LEGACY = "legacy"
CLASS_OUTDATED = "outdated"
CLASS_CURRENT_DEMO = "current-demo"

# ── Legacy DataSource signature (STRICT CONJUNCTION) ───────────────────────
# All three must hold. The name pattern alone also matches a *current* demo's
# synthetic source (``Demo warehouse <slug>``), which is exactly why host and
# db_type are required: only the pre-epic clickhouse@demo.internal shape is legacy.
LEGACY_SOURCE_NAME_LIKE = "Demo warehouse %"
LEGACY_SOURCE_HOST = "demo.internal"
LEGACY_SOURCE_DB_TYPE = DBType.clickhouse.value

# A plan row whose ``updated_at`` sits more than this past the seed's completion is
# treated as a genuine user edit (seeding writes every row inside one sub-second
# transaction, so the whole seed shares an ``updated_at`` well within this margin).
_SEED_EDIT_TOLERANCE = timedelta(minutes=1)


def _current_recipe_int() -> int:
    return _recipe_int(DEMO_RECIPE_VERSION)


def _recipe_int(value: str | None) -> int:
    """Parse a recipe version to an int for ordering; unknown/None sorts oldest."""
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return -1


def _legacy_source_conditions() -> tuple[ColumnElement[bool], ...]:
    """The strict-conjunction column predicates identifying a legacy demo source."""
    return (
        DataSource.name.like(LEGACY_SOURCE_NAME_LIKE),
        DataSource.host == LEGACY_SOURCE_HOST,
        DataSource.db_type == LEGACY_SOURCE_DB_TYPE,
    )


def is_outdated_demo(project: Project) -> bool:
    """A first-class demo (``is_demo=True``) seeded by an older recipe than current."""
    if not project.is_demo:
        return False
    return _recipe_int(project.demo_recipe_version) < _current_recipe_int()


async def project_has_legacy_source(session: AsyncSession, project_id: uuid.UUID) -> bool:
    """Whether *project_id* owns or references a legacy-signature DataSource."""
    referenced_sources = select(ScanConfig.data_source_id).where(
        ScanConfig.project_id == project_id
    )
    stmt = (
        select(DataSource.id)
        .where(
            *_legacy_source_conditions(),
            or_(
                DataSource.project_id == project_id,
                DataSource.id.in_(referenced_sources),
            ),
        )
        .limit(1)
    )
    return (await session.execute(stmt)).first() is not None


async def legacy_project_ids(
    session: AsyncSession, project_ids: list[uuid.UUID]
) -> set[uuid.UUID]:
    """Batched: the subset of *project_ids* that reference a legacy-signature source.

    Caller must gate on ``is_demo`` — a current demo is never legacy. One UNION
    query so listing N projects does not fan out to N per-project probes.
    """
    if not project_ids:
        return set()
    conditions = _legacy_source_conditions()
    owned = select(DataSource.project_id).where(
        *conditions, DataSource.project_id.in_(project_ids)
    )
    referenced = (
        select(ScanConfig.project_id)
        .join(DataSource, ScanConfig.data_source_id == DataSource.id)
        .where(*conditions, ScanConfig.project_id.in_(project_ids))
    )
    rows = (await session.execute(owned.union(referenced))).all()
    return {row[0] for row in rows if row[0] is not None}


async def classify_project(session: AsyncSession, project: Project) -> str:
    """Classify *project* as ``real | legacy | outdated | current-demo``."""
    if project.is_demo:
        return CLASS_OUTDATED if is_outdated_demo(project) else CLASS_CURRENT_DEMO
    if await project_has_legacy_source(session, project.id):
        return CLASS_LEGACY
    return CLASS_REAL


async def classification_flags(
    session: AsyncSession, project: Project
) -> tuple[bool, bool]:
    """Return ``(demo_legacy, demo_outdated)`` for a single project."""
    demo_outdated = is_outdated_demo(project)
    demo_legacy = (not project.is_demo) and await project_has_legacy_source(
        session, project.id
    )
    return demo_legacy, demo_outdated


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


async def _seed_anchor(session: AsyncSession, project: Project) -> datetime:
    """The instant the seed finished: max plan-row ``created_at``, else project's."""
    latest = (
        await session.execute(
            select(func.max(Event.created_at)).where(Event.project_id == project.id)
        )
    ).scalar()
    return _aware(latest or project.created_at)


async def is_demo_edited(session: AsyncSession, project: Project) -> bool:
    """Heuristic: has a user edited this demo's plan since it was seeded?

    An unedited demo has every ``Event.updated_at`` at (or within a hair of) seed
    completion. A later edit bumps ``updated_at`` past the seed anchor, which we
    detect on any Event (the primary user-edited plan entity — ``Event`` carries a
    ``TimestampMixin``, unlike ``Variable``). Used to REFUSE a silent overwrite on
    upgrade unless the caller explicitly forces it.
    """
    threshold = await _seed_anchor(session, project) + _SEED_EDIT_TOLERANCE
    edited_event = (
        await session.execute(
            select(Event.id)
            .where(Event.project_id == project.id, Event.updated_at > threshold)
            .limit(1)
        )
    ).first()
    return edited_event is not None


async def upgrade_demo(
    session: AsyncSession,
    slug: str,
    *,
    created_by: uuid.UUID | None = None,
    force: bool = False,
) -> ProjectResponse:
    """Re-provision a legacy/outdated demo under the CURRENT recipe, in place.

    * A ``real`` project is not upgradable (404).
    * A ``current-demo`` is already current (409 — use reset to re-seed).
    * A demo with local edits is preserved: 409 unless ``force=True``.

    Legacy demos predate ``is_demo``; they are first *adopted* (marked
    ``is_demo=True``) so the standard reset (delete + recreate under the same
    slug) applies, then the now-orphaned legacy source is swept.
    """
    # Lazy imports: these modules import back into the demo stack, so importing
    # them at module load would form a cycle (project_service -> demo_legacy_service).
    from tripl.services import demo_service, project_service

    project = await project_service.get_project_by_slug(session, slug)
    classification = await classify_project(session, project)

    if classification == CLASS_REAL:
        raise HTTPException(status_code=404, detail="Not an upgradable demo")
    if classification == CLASS_CURRENT_DEMO:
        raise HTTPException(
            status_code=409, detail="Demo is already on the current recipe"
        )
    if not force and await is_demo_edited(session, project):
        raise HTTPException(
            status_code=409,
            detail=(
                "This demo has local edits; re-provisioning would discard them. "
                "Pass force=true to upgrade anyway."
            ),
        )

    creator = project.created_by_user_id or created_by

    if classification == CLASS_LEGACY:
        # The re-provision mints a fresh synthetic source under the SAME canonical
        # name (``Demo warehouse <slug>``, which DataSource.name uniquely
        # constrains), so THIS demo's own legacy source + scan configs must go
        # first or the recreate collides. Only sources tied to this project are
        # touched — real, workspace-global sources are never in scope.
        await _remove_project_legacy_sources(session, project.id)
        # Adopt so ``reset_demo_project`` accepts it, then re-provision in place.
        project.is_demo = True
        project.demo_recipe_version = None
        await session.commit()
        result = await demo_service.reset_demo_project(session, slug, created_by=creator)
        await cleanup_orphan_legacy_sources(session)
        return result

    # Outdated first-class demo: reset re-runs the current recipe under the slug.
    return await demo_service.reset_demo_project(session, slug, created_by=creator)


async def _remove_project_legacy_sources(
    session: AsyncSession, project_id: uuid.UUID
) -> None:
    """Delete the legacy demo source(s) tied to *project_id* (and their scan configs).

    Scoped strictly to legacy-signature sources this project owns or references, so
    it can never remove a real, workspace-global source. Deletes the referencing
    scan configs first (SQLite has no FK cascade) so the source rows can go.
    """
    referenced_sources = select(ScanConfig.data_source_id).where(
        ScanConfig.project_id == project_id
    )
    source_ids = [
        row[0]
        for row in (
            await session.execute(
                select(DataSource.id).where(
                    *_legacy_source_conditions(),
                    or_(
                        DataSource.project_id == project_id,
                        DataSource.id.in_(referenced_sources),
                    ),
                )
            )
        ).all()
    ]
    if not source_ids:
        return
    await session.execute(
        delete(ScanConfig).where(ScanConfig.data_source_id.in_(source_ids))
    )
    await session.execute(delete(DataSource).where(DataSource.id.in_(source_ids)))
    await session.flush()


async def cleanup_orphan_legacy_sources(session: AsyncSession) -> int:
    """Delete ONLY proven-orphan legacy demo sources; never touch a real source.

    A legacy source is removable only when it carries the full legacy signature,
    is unowned (``project_id IS NULL``), and no ``ScanConfig`` references it — so a
    legacy source still wired to any project is left strictly alone. Returns the
    number of sources removed.
    """
    referenced_source_ids = select(ScanConfig.data_source_id)
    orphan_ids = [
        row[0]
        for row in (
            await session.execute(
                select(DataSource.id).where(
                    *_legacy_source_conditions(),
                    DataSource.project_id.is_(None),
                    DataSource.id.not_in(referenced_source_ids),
                )
            )
        ).all()
    ]
    if not orphan_ids:
        return 0
    await session.execute(delete(DataSource).where(DataSource.id.in_(orphan_ids)))
    await session.commit()
    await cache.delete_prefix(cache.prefix_data_sources())
    return len(orphan_ids)
