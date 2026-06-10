"""Read/write helpers for SchemaDrift records."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from tripl import cache
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.schema_drift import SchemaDrift
from tripl.models.user import User
from tripl.schemas.schema_drift import (
    SchemaDriftActionRequest,
    SchemaDriftListResponse,
    SchemaDriftResponse,
)
from tripl.services.project_lookup import get_project_id_by_slug
from tripl.services.search_service import reindex_project_branch

# Drift rows older than this are filtered out at read time. The writer
# upserts on (event_type_id, field_name, drift_type) so a drift that
# clears naturally just stops being refreshed and ages out of view.
DRIFT_RETENTION_DAYS = 30
ACTIVE_DRIFT_STATUSES = {"open", "snoozed"}


def _retention_cutoff(now: datetime | None = None) -> datetime:
    now = now or datetime.now(UTC)
    return now - timedelta(days=DRIFT_RETENTION_DAYS)


def _active_drift_predicates(now: datetime) -> list[ColumnElement[bool]]:
    return [
        SchemaDrift.status.in_(ACTIVE_DRIFT_STATUSES),
        (SchemaDrift.status != "snoozed")
        | (SchemaDrift.snoozed_until.is_(None))
        | (SchemaDrift.snoozed_until <= now),
    ]


def _logical_type_from_observed(observed_type: str | None) -> str:
    value = (observed_type or "").lower()
    if any(marker in value for marker in ("json", "object", "tuple", "map")):
        return "json"
    if any(marker in value for marker in ("int", "float", "decimal", "numeric", "double")):
        return "number"
    if "bool" in value:
        return "boolean"
    return "string"


async def _apply_acceptance_to_plan(
    session: AsyncSession,
    *,
    drift: SchemaDrift,
    event_type: EventType,
) -> bool:
    field = await session.scalar(
        select(FieldDefinition).where(
            FieldDefinition.event_type_id == event_type.id,
            FieldDefinition.name == drift.field_name,
        )
    )
    if drift.drift_type == "new_field":
        if field is not None:
            return False
        next_order = await session.scalar(
            select(func.max(FieldDefinition.order)).where(
                FieldDefinition.event_type_id == event_type.id
            )
        )
        session.add(
            FieldDefinition(
                event_type_id=event_type.id,
                name=drift.field_name,
                display_name=drift.field_name,
                field_type=_logical_type_from_observed(drift.observed_type),
                is_required=False,
                description="Accepted from schema drift",
                order=(next_order or 0) + 1,
            )
        )
        return True
    if drift.drift_type == "type_changed" and field is not None:
        field.field_type = _logical_type_from_observed(drift.observed_type)
        return True
    if drift.drift_type == "missing_field" and field is not None:
        await session.delete(field)
        return True
    return False


async def list_drifts_for_event_type(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID,
) -> SchemaDriftListResponse:
    project_id = await get_project_id_by_slug(session, slug, detail=f"Project '{slug}' not found")

    event_type = await session.get(EventType, event_type_id)
    if event_type is None or event_type.project_id != project_id:
        raise HTTPException(status_code=404, detail="Event type not found")

    cutoff = _retention_cutoff()
    rows = (
        (
            await session.execute(
                select(SchemaDrift)
                .where(
                    SchemaDrift.event_type_id == event_type_id,
                    SchemaDrift.detected_at >= cutoff,
                )
                .order_by(SchemaDrift.detected_at.desc(), SchemaDrift.field_name)
            )
        )
        .scalars()
        .all()
    )

    items = [SchemaDriftResponse.model_validate(row) for row in rows]
    return SchemaDriftListResponse(items=items, total=len(items))


async def apply_drift_action(
    session: AsyncSession,
    slug: str,
    drift_id: uuid.UUID,
    data: SchemaDriftActionRequest,
    user: User,
) -> SchemaDriftResponse:
    project_id = await get_project_id_by_slug(session, slug, detail=f"Project '{slug}' not found")
    row = (
        await session.execute(
            select(SchemaDrift, EventType)
            .join(EventType, EventType.id == SchemaDrift.event_type_id)
            .where(
                SchemaDrift.id == drift_id,
                EventType.project_id == project_id,
            )
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Schema drift not found")

    drift, event_type = row
    now = datetime.now(UTC)
    plan_changed = False
    if data.action == "accept":
        plan_changed = await _apply_acceptance_to_plan(
            session,
            drift=drift,
            event_type=event_type,
        )
        drift.status = "accepted"
        drift.resolved_at = now
        drift.resolved_by = user.id
        drift.snoozed_until = None
    elif data.action == "snooze":
        drift.status = "snoozed"
        drift.snoozed_until = data.snoozed_until
        drift.resolved_at = None
        drift.resolved_by = user.id
    elif data.action == "false_positive":
        drift.status = "false_positive"
        drift.resolved_at = now
        drift.resolved_by = user.id
        drift.snoozed_until = None
    elif data.action == "reopen":
        drift.status = "open"
        drift.resolved_at = None
        drift.resolved_by = None
        drift.snoozed_until = None
    else:
        raise HTTPException(status_code=422, detail="Unsupported schema drift action")

    drift.resolution_note = data.note
    await session.commit()
    await session.refresh(drift)

    if plan_changed:
        await reindex_project_branch(
            session,
            project_id=event_type.project_id,
            branch_id=event_type.branch_id,
            slug=slug,
        )
        if event_type.branch_id is None:
            await cache.delete_prefix(cache.prefix_event_types(slug))
    return SchemaDriftResponse.model_validate(drift)


async def get_drift_counts_by_event_type(
    session: AsyncSession,
    project_id: uuid.UUID,
    event_type_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    if not event_type_ids:
        return {}
    now = datetime.now(UTC)
    cutoff = _retention_cutoff(now)
    rows = (
        await session.execute(
            select(SchemaDrift.event_type_id, func.count(SchemaDrift.id))
            .join(EventType, EventType.id == SchemaDrift.event_type_id)
            .where(
                EventType.project_id == project_id,
                SchemaDrift.event_type_id.in_(event_type_ids),
                SchemaDrift.detected_at >= cutoff,
                *_active_drift_predicates(now),
            )
            .group_by(SchemaDrift.event_type_id)
        )
    ).all()
    return {event_type_id: count for event_type_id, count in rows}
