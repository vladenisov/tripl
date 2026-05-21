"""CRUD service for chart annotations (deploy/release markers)."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.chart_annotation import ChartAnnotation
from tripl.services.project_service import get_project_id_by_slug

ALLOWED_SCOPES = {"project_total", "event_type", "event"}


def _validate_scope(scope_type: str | None, scope_ref: str | None) -> None:
    if scope_type is None and scope_ref is None:
        return
    if scope_type is None or scope_ref is None:
        raise HTTPException(
            status_code=422,
            detail="scope_type and scope_ref must both be provided or both be null",
        )
    if scope_type not in ALLOWED_SCOPES:
        raise HTTPException(
            status_code=422,
            detail=f"scope_type must be one of {sorted(ALLOWED_SCOPES)}",
        )


async def list_annotations(
    session: AsyncSession,
    slug: str,
    *,
    scope_type: str | None = None,
    scope_ref: str | None = None,
    time_from: datetime | None = None,
    time_to: datetime | None = None,
) -> list[ChartAnnotation]:
    """Return annotations visible for the requested chart scope.

    Project-wide markers (scope_type IS NULL) are always included; scoped
    markers are filtered to the given scope_type/ref pair when provided.
    """
    project_id = await get_project_id_by_slug(session, slug)

    conditions = [ChartAnnotation.project_id == project_id]
    if scope_type is not None and scope_ref is not None:
        conditions.append(
            or_(
                ChartAnnotation.scope_type.is_(None),
                and_(
                    ChartAnnotation.scope_type == scope_type,
                    ChartAnnotation.scope_ref == scope_ref,
                ),
            )
        )
    if time_from is not None:
        conditions.append(ChartAnnotation.bucket >= time_from)
    if time_to is not None:
        conditions.append(ChartAnnotation.bucket <= time_to)

    rows = await session.execute(
        select(ChartAnnotation).where(*conditions).order_by(ChartAnnotation.bucket.asc())
    )
    return list(rows.scalars().all())


async def create_annotation(
    session: AsyncSession,
    slug: str,
    *,
    bucket: datetime,
    label: str,
    description: str | None,
    color: str,
    scope_type: str | None,
    scope_ref: str | None,
    user_id: uuid.UUID | None,
) -> ChartAnnotation:
    project_id = await get_project_id_by_slug(session, slug)
    _validate_scope(scope_type, scope_ref)

    annotation = ChartAnnotation(
        project_id=project_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        bucket=bucket,
        label=label.strip(),
        description=description.strip() if description else None,
        color=color,
        created_by_user_id=user_id,
    )
    session.add(annotation)
    await session.commit()
    await session.refresh(annotation)
    return annotation


async def delete_annotation(
    session: AsyncSession,
    slug: str,
    annotation_id: uuid.UUID,
) -> None:
    project_id = await get_project_id_by_slug(session, slug)
    annotation = await session.get(ChartAnnotation, annotation_id)
    if annotation is None or annotation.project_id != project_id:
        raise HTTPException(status_code=404, detail="Annotation not found")
    await session.delete(annotation)
    await session.commit()
