"""Read-side helpers for SchemaDrift records.

Writers live in the metrics worker (see `_detect_event_type_drift`); the
service surface is intentionally read-only for the API layer.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.event_type import EventType
from tripl.models.project import Project
from tripl.models.schema_drift import SchemaDrift
from tripl.schemas.schema_drift import SchemaDriftListResponse, SchemaDriftResponse

# Drift rows older than this are filtered out at read time. The writer
# upserts on (event_type_id, field_name, drift_type) so a drift that
# clears naturally just stops being refreshed and ages out of view.
DRIFT_RETENTION_DAYS = 30


def _retention_cutoff(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    return now - timedelta(days=DRIFT_RETENTION_DAYS)


async def _resolve_project_id(session: AsyncSession, slug: str) -> uuid.UUID:
    project_id = await session.scalar(select(Project.id).where(Project.slug == slug))
    if project_id is None:
        raise HTTPException(status_code=404, detail=f"Project '{slug}' not found")
    return project_id


async def list_drifts_for_event_type(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
) -> SchemaDriftListResponse:
    project_id = await _resolve_project_id(session, slug)

    event_type = await session.get(EventType, event_type_id)
    if event_type is None or event_type.project_id != project_id:
        raise HTTPException(status_code=404, detail="Event type not found")

    cutoff = _retention_cutoff()
    rows = (
        await session.execute(
            select(SchemaDrift)
            .where(
                SchemaDrift.event_type_id == event_type_id,
                SchemaDrift.detected_at >= cutoff,
            )
            .order_by(SchemaDrift.detected_at.desc(), SchemaDrift.field_name)
        )
    ).scalars().all()

    items = [SchemaDriftResponse.model_validate(row) for row in rows]
    return SchemaDriftListResponse(items=items, total=len(items))


async def get_drift_counts_by_event_type(
    session: AsyncSession,
    project_id: uuid.UUID,
    event_type_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    if not event_type_ids:
        return {}
    cutoff = _retention_cutoff()
    rows = (
        await session.execute(
            select(SchemaDrift.event_type_id, func.count(SchemaDrift.id))
            .join(EventType, EventType.id == SchemaDrift.event_type_id)
            .where(
                EventType.project_id == project_id,
                SchemaDrift.event_type_id.in_(event_type_ids),
                SchemaDrift.detected_at >= cutoff,
            )
            .group_by(SchemaDrift.event_type_id)
        )
    ).all()
    return {event_type_id: count for event_type_id, count in rows}
