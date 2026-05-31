from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.project import Project

PROJECT_NOT_FOUND = "Project not found"


async def get_project_by_slug(
    session: AsyncSession,
    slug: str,
    *,
    detail: str = PROJECT_NOT_FOUND,
) -> Project:
    project = await session.scalar(select(Project).where(Project.slug == slug))
    if project is None:
        raise HTTPException(status_code=404, detail=detail)
    return project


async def get_project_id_by_slug(
    session: AsyncSession,
    slug: str,
    *,
    detail: str = PROJECT_NOT_FOUND,
) -> uuid.UUID:
    project_id = await session.scalar(select(Project.id).where(Project.slug == slug))
    if project_id is None:
        raise HTTPException(status_code=404, detail=detail)
    return project_id
