from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from tripl.config import settings
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.project import Project
from tripl.services.search_service import reindex_project_branch

logger = logging.getLogger(__name__)


def reindex_main_branch_from_worker(session: Session, project_id: uuid.UUID) -> None:
    bind = session.bind
    if bind is None or bind.dialect.name != "postgresql":
        return

    project = session.get(Project, project_id)
    branch_id = session.scalar(
        select(PlanBranch.id).where(
            PlanBranch.project_id == project_id,
            PlanBranch.kind == BranchKind.main.value,
        )
    )
    if project is None or branch_id is None:
        return

    slug = project.slug

    async def _run() -> None:
        # A Celery prefork worker is long-lived and reaches this via a fresh
        # asyncio.run() (a brand-new event loop) on every scan/metrics refresh.
        # asyncpg binds each connection to the loop that opened it, so reusing
        # the module-global pooled async engine would hand a later loop a
        # connection created under an already-closed loop ("got Future attached
        # to a different loop"). Build a throwaway NullPool engine whose
        # connections live and die entirely inside this loop, and dispose it
        # before the loop closes.
        engine = create_async_engine(settings.database_url, poolclass=NullPool)
        try:
            session_factory = async_sessionmaker(engine, expire_on_commit=False)
            async with session_factory() as async_db:
                await reindex_project_branch(
                    async_db,
                    project_id=project_id,
                    branch_id=branch_id,
                    slug=slug,
                )
        finally:
            await engine.dispose()

    try:
        asyncio.run(_run())
    except Exception:
        logger.exception("Failed to reindex search documents after worker catalog refresh")
