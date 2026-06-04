from __future__ import annotations

import asyncio
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.database import async_session
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.project import Project
from tripl.services.search_service import reindex_project_branch

logger = logging.getLogger(__name__)


def reindex_main_branch_from_worker(session: Session, project_id: uuid.UUID) -> None:
    if session.get_bind().dialect.name != "postgresql":
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

    async def _run() -> None:
        async with async_session() as async_db:
            await reindex_project_branch(
                async_db,
                project_id=project_id,
                branch_id=branch_id,
                slug=project.slug,
            )

    try:
        asyncio.run(_run())
    except Exception:
        logger.exception("Failed to reindex search documents after worker catalog refresh")
