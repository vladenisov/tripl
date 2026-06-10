import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

from tripl import cache
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_meta_value import EventMetaValue
from tripl.models.event_tag import EventTag
from tripl.models.field_definition import FieldDefinition
from tripl.schemas.event import (
    EventBulkDelete,
    EventBulkUpdate,
    EventCreate,
    EventFieldValueIn,
    EventMove,
    EventReorder,
    EventUpdate,
)
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug
from tripl.services.schema_drift_service import get_drift_counts_by_event_type
from tripl.services.search_service import reindex_project_branch
from tripl.services.variable_value_service import attach_event_field_variable_values


async def _validate_field_values(
    session: AsyncSession, event_type_id: uuid.UUID, field_values: list[EventFieldValueIn]
) -> None:
    result = await session.execute(
        select(FieldDefinition).where(FieldDefinition.event_type_id == event_type_id)
    )
    field_defs = {fd.id: fd for fd in result.scalars().all()}

    provided_ids = {fv.field_definition_id for fv in field_values}
    for fd_id, fd in field_defs.items():
        if fd.is_required and fd_id not in provided_ids:
            raise HTTPException(status_code=422, detail=f"Required field '{fd.name}' is missing")
    for fv in field_values:
        if fv.field_definition_id not in field_defs:
            raise HTTPException(
                status_code=422, detail=f"Field definition {fv.field_definition_id} not found"
            )


async def list_events(
    session: AsyncSession,
    slug: str,
    event_type_id: uuid.UUID | None = None,
    search: str | None = None,
    implemented: bool | None = None,
    tag: str | None = None,
    reviewed: bool | None = None,
    archived: bool | None = None,
    offset: int = 0,
    limit: int = 200,
    silent_since_days: int | None = None,
    field_value: str | None = None,
    meta_value: str | None = None,
    branch_id: uuid.UUID | None = None,
) -> tuple[list[Event], int]:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    # Skip the selectin load for Event.event_type — the list response schema
    # ships only event_type_id, and the client already has EventTypes cached.
    query = (
        select(Event)
        .where(Event.project_id == project_id, Event.branch_id == branch_id)
        .options(noload(Event.event_type))
    )
    count_query = select(func.count(Event.id)).where(
        Event.project_id == project_id, Event.branch_id == branch_id
    )

    if event_type_id:
        query = query.where(Event.event_type_id == event_type_id)
        count_query = count_query.where(Event.event_type_id == event_type_id)
    if search:
        # Local list search is a plain substring filter across the visible
        # text columns (name, description, and the legacy "old" source_name).
        # The semantic/hybrid search lives in the global command palette only;
        # wiring it in here broke exact-match filtering whenever the search
        # index had not been (re)built for the project/branch yet.
        search_clause = or_(
            Event.name.ilike(f"%{search}%"),
            Event.description.ilike(f"%{search}%"),
            Event.source_name.ilike(f"%{search}%"),
        )
        query = query.where(search_clause)
        count_query = count_query.where(search_clause)
    if implemented is not None:
        query = query.where(Event.implemented == implemented)
        count_query = count_query.where(Event.implemented == implemented)
    if reviewed is not None:
        query = query.where(Event.reviewed == reviewed)
        count_query = count_query.where(Event.reviewed == reviewed)
    if archived is not None:
        query = query.where(Event.archived == archived)
        count_query = count_query.where(Event.archived == archived)
    if tag:
        tag_filter = select(EventTag.event_id).where(EventTag.name == tag).correlate(None)
        query = query.where(Event.id.in_(tag_filter))
        count_query = count_query.where(Event.id.in_(tag_filter))
    if field_value:
        fv_filter = (
            select(EventFieldValue.event_id)
            .where(EventFieldValue.value.ilike(f"%{field_value}%"))
            .correlate(None)
        )
        query = query.where(Event.id.in_(fv_filter))
        count_query = count_query.where(Event.id.in_(fv_filter))
    if meta_value:
        mv_filter = (
            select(EventMetaValue.event_id)
            .where(EventMetaValue.value.ilike(f"%{meta_value}%"))
            .correlate(None)
        )
        query = query.where(Event.id.in_(mv_filter))
        count_query = count_query.where(Event.id.in_(mv_filter))
    if silent_since_days is not None and silent_since_days >= 0:
        cutoff = datetime.now(UTC) - timedelta(days=silent_since_days)
        silent_clause = or_(Event.last_seen_at.is_(None), Event.last_seen_at < cutoff)
        query = query.where(silent_clause)
        count_query = count_query.where(silent_clause)

    total = (await session.execute(count_query)).scalar() or 0
    result = await session.execute(
        query.order_by(
            Event.order.asc(),
            Event.created_at.desc(),
            Event.id.asc(),
        )
        .offset(offset)
        .limit(limit)
    )
    events = list(result.scalars().all())

    # Project SchemaDrift counts (per event_type) onto each event so the API
    # ships drift signal alongside the catalog row without an extra round-trip.
    event_type_ids = list({event.event_type_id for event in events})
    drift_counts = await get_drift_counts_by_event_type(session, project_id, event_type_ids)
    for event in events:
        event.drift_count = drift_counts.get(event.event_type_id, 0)  # type: ignore[attr-defined]

    await attach_event_field_variable_values(session, events)
    return events, total


async def _get_next_event_order(
    session: AsyncSession, project_id: uuid.UUID, branch_id: uuid.UUID
) -> int:
    max_order = await session.scalar(
        select(func.max(Event.order)).where(
            Event.project_id == project_id, Event.branch_id == branch_id
        )
    )
    return int(max_order or 0) + 1 if max_order is not None else 0


async def list_tags(
    session: AsyncSession, slug: str, branch_id: uuid.UUID | None = None
) -> list[str]:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    result = await session.execute(
        select(EventTag.name)
        .join(Event, EventTag.event_id == Event.id)
        .where(Event.project_id == project_id, Event.branch_id == branch_id)
        .distinct()
        .order_by(EventTag.name)
    )
    return list(result.scalars().all())


async def get_event(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> Event:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    result = await session.execute(
        select(Event).where(
            Event.id == event_id,
            Event.project_id == project_id,
            Event.branch_id == branch_id,
        )
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    await attach_event_field_variable_values(session, [event])
    return event


async def create_event(
    session: AsyncSession,
    slug: str,
    data: EventCreate,
    branch_id: uuid.UUID | None = None,
) -> Event:
    is_main = branch_id is None
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    await _validate_field_values(session, data.event_type_id, data.field_values)

    event = Event(
        project_id=project_id,
        branch_id=branch_id,
        event_type_id=data.event_type_id,
        name=data.name,
        description=data.description,
        order=await _get_next_event_order(session, project_id, branch_id),
        implemented=data.implemented,
        reviewed=data.reviewed,
        archived=data.archived,
        metric_breakdown_columns=data.metric_breakdown_columns,
    )
    session.add(event)
    await session.flush()

    for fv in data.field_values:
        session.add(
            EventFieldValue(
                event_id=event.id,
                field_definition_id=fv.field_definition_id,
                value=fv.value,
            )
        )
    for mv in data.meta_values:
        session.add(
            EventMetaValue(
                event_id=event.id,
                meta_field_definition_id=mv.meta_field_definition_id,
                value=mv.value,
            )
        )
    for tag_name in data.tags:
        session.add(EventTag(event_id=event.id, name=tag_name))

    await session.commit()
    await session.refresh(event)
    await attach_event_field_variable_values(session, [event])
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())
    return event


async def update_event(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    data: EventUpdate,
    branch_id: uuid.UUID | None = None,
) -> Event:
    is_main = branch_id is None
    event = await get_event(session, slug, event_id, branch_id)
    update_data = data.model_dump(exclude_unset=True)

    if "name" in update_data:
        event.name = update_data["name"]
    if "description" in update_data:
        event.description = update_data["description"]
    if "implemented" in update_data:
        event.implemented = update_data["implemented"]
    if "reviewed" in update_data:
        event.reviewed = update_data["reviewed"]
    if "archived" in update_data:
        event.archived = update_data["archived"]
    if "metric_breakdown_columns" in update_data:
        event.metric_breakdown_columns = update_data["metric_breakdown_columns"]

    # Replace child rows via a single DELETE+INSERT-batch per relation, instead
    # of `await session.delete(row)` per existing child (was ~N round-trips).
    if data.tags is not None:
        await session.execute(delete(EventTag).where(EventTag.event_id == event.id))
        await session.flush()
        if data.tags:
            session.add_all([EventTag(event_id=event.id, name=name) for name in data.tags])

    if data.field_values is not None:
        await _validate_field_values(session, event.event_type_id, data.field_values)
        # VariableValue rows are scan-observed contexts keyed by field_definition_id,
        # not by EventFieldValue rows — manual edits must not wipe them.
        await session.execute(delete(EventFieldValue).where(EventFieldValue.event_id == event.id))
        await session.flush()
        if data.field_values:
            session.add_all(
                [
                    EventFieldValue(
                        event_id=event.id,
                        field_definition_id=field_value.field_definition_id,
                        value=field_value.value,
                    )
                    for field_value in data.field_values
                ]
            )

    if data.meta_values is not None:
        await session.execute(delete(EventMetaValue).where(EventMetaValue.event_id == event.id))
        await session.flush()
        if data.meta_values:
            session.add_all(
                [
                    EventMetaValue(
                        event_id=event.id,
                        meta_field_definition_id=meta_value.meta_field_definition_id,
                        value=meta_value.value,
                    )
                    for meta_value in data.meta_values
                ]
            )

    await session.commit()
    await session.refresh(event)
    await attach_event_field_variable_values(session, [event])
    await reindex_project_branch(
        session,
        project_id=event.project_id,
        branch_id=event.branch_id,
        slug=slug,
    )
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())
    return event


async def delete_event(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> None:
    is_main = branch_id is None
    event = await get_event(session, slug, event_id, branch_id)
    project_id = event.project_id
    resolved_branch_id = event.branch_id
    await session.delete(event)
    await session.commit()
    await reindex_project_branch(
        session,
        project_id=project_id,
        branch_id=resolved_branch_id,
        slug=slug,
    )
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())


async def bulk_delete_events(
    session: AsyncSession,
    slug: str,
    data: EventBulkDelete,
    branch_id: uuid.UUID | None = None,
) -> None:
    is_main = branch_id is None
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    # Validate all ids exist + belong to this project+branch in a single count query.
    present = await session.scalar(
        select(func.count(Event.id)).where(
            Event.project_id == project_id,
            Event.branch_id == branch_id,
            Event.id.in_(data.event_ids),
        )
    )
    if (present or 0) != len(data.event_ids):
        raise HTTPException(status_code=404, detail="One or more events were not found")

    # Single DELETE with IN-list; child rows go via FK ondelete=CASCADE in the DB.
    await session.execute(
        delete(Event).where(
            Event.project_id == project_id,
            Event.branch_id == branch_id,
            Event.id.in_(data.event_ids),
        )
    )
    await session.commit()
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())


async def bulk_update_events(
    session: AsyncSession,
    slug: str,
    data: EventBulkUpdate,
    branch_id: uuid.UUID | None = None,
) -> None:
    is_main = branch_id is None
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    event_ids = set(data.event_ids)

    present = await session.scalar(
        select(func.count(Event.id)).where(
            Event.project_id == project_id,
            Event.branch_id == branch_id,
            Event.id.in_(event_ids),
        )
    )
    if (present or 0) != len(event_ids):
        raise HTTPException(status_code=404, detail="One or more events were not found")

    update_values = data.model_dump(
        exclude={"event_ids"},
        exclude_none=True,
    )
    await session.execute(
        sql_update(Event)
        .where(
            Event.project_id == project_id,
            Event.branch_id == branch_id,
            Event.id.in_(event_ids),
        )
        .values(**update_values)
    )
    await session.commit()
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())


async def move_event(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    data: EventMove,
    branch_id: uuid.UUID | None = None,
) -> Event:
    event = await get_event(session, slug, event_id, branch_id)

    query = select(Event).where(
        Event.project_id == event.project_id, Event.branch_id == event.branch_id
    )
    if data.visible_event_ids:
        query = query.where(Event.id.in_(data.visible_event_ids))

    result = await session.execute(
        query.order_by(Event.order.asc(), Event.created_at.desc(), Event.id.asc())
    )
    ordered_events = list(result.scalars().all())
    ordered_ids = [item.id for item in ordered_events]
    if event.id not in ordered_ids:
        raise HTTPException(status_code=400, detail="Event is not present in the visible ordering")

    current_index = ordered_ids.index(event.id)
    target_index = current_index - 1 if data.direction == "up" else current_index + 1
    if target_index < 0 or target_index >= len(ordered_events):
        return event

    target = ordered_events[target_index]
    event.order, target.order = target.order, event.order
    await session.commit()
    await session.refresh(event)
    await attach_event_field_variable_values(session, [event])
    return event


async def reorder_events(
    session: AsyncSession,
    slug: str,
    data: EventReorder,
    branch_id: uuid.UUID | None = None,
) -> list[Event]:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)

    result = await session.execute(
        select(Event).where(
            Event.project_id == project_id,
            Event.branch_id == branch_id,
            Event.id.in_(data.event_ids),
        )
    )
    events = list(result.scalars().all())
    if len(events) != len(set(data.event_ids)):
        raise HTTPException(status_code=400, detail="Some events do not belong to this project")

    events_by_id = {event.id: event for event in events}
    sorted_orders = sorted(event.order for event in events)
    for new_index, event_id in enumerate(data.event_ids):
        events_by_id[event_id].order = sorted_orders[new_index]

    await session.commit()
    # One round-trip with selectin relations (event_type/field_values/meta_values/tags)
    # instead of N×refresh after commit.
    refreshed = await session.execute(select(Event).where(Event.id.in_(data.event_ids)))
    by_id = {event.id: event for event in refreshed.scalars().all()}
    ordered_events = [by_id[event_id] for event_id in data.event_ids]
    await attach_event_field_variable_values(session, ordered_events)
    return ordered_events


async def bulk_create_events(
    session: AsyncSession,
    slug: str,
    events_data: list[EventCreate],
    branch_id: uuid.UUID | None = None,
) -> list[Event]:
    if not events_data:
        return []

    is_main = branch_id is None
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)

    # Batched per-event-type validation: one SELECT per unique event_type_id, then
    # per-event check using the cached field definitions.
    unique_event_type_ids = {data.event_type_id for data in events_data}
    field_defs_by_type: dict[uuid.UUID, dict[uuid.UUID, FieldDefinition]] = {}
    for event_type_id in unique_event_type_ids:
        result = await session.execute(
            select(FieldDefinition).where(FieldDefinition.event_type_id == event_type_id)
        )
        field_defs_by_type[event_type_id] = {fd.id: fd for fd in result.scalars().all()}

    for data in events_data:
        defs = field_defs_by_type[data.event_type_id]
        provided_ids = {fv.field_definition_id for fv in data.field_values}
        for fd_id, fd in defs.items():
            if fd.is_required and fd_id not in provided_ids:
                raise HTTPException(
                    status_code=422, detail=f"Required field '{fd.name}' is missing"
                )
        for fv in data.field_values:
            if fv.field_definition_id not in defs:
                raise HTTPException(
                    status_code=422,
                    detail=f"Field definition {fv.field_definition_id} not found",
                )

    # One SELECT max(order) instead of N — we assign consecutive orders ourselves.
    base_order = await _get_next_event_order(session, project_id, branch_id)

    events: list[Event] = []
    for i, data in enumerate(events_data):
        events.append(
            Event(
                project_id=project_id,
                branch_id=branch_id,
                event_type_id=data.event_type_id,
                name=data.name,
                description=data.description,
                order=base_order + i,
                implemented=data.implemented,
                reviewed=data.reviewed,
                archived=data.archived,
                metric_breakdown_columns=data.metric_breakdown_columns,
            )
        )
    session.add_all(events)
    await session.flush()

    children: list[EventFieldValue | EventMetaValue | EventTag] = []
    for event, data in zip(events, events_data, strict=True):
        for fv in data.field_values:
            children.append(
                EventFieldValue(
                    event_id=event.id,
                    field_definition_id=fv.field_definition_id,
                    value=fv.value,
                )
            )
        for mv in data.meta_values:
            children.append(
                EventMetaValue(
                    event_id=event.id,
                    meta_field_definition_id=mv.meta_field_definition_id,
                    value=mv.value,
                )
            )
        for tag_name in data.tags:
            children.append(EventTag(event_id=event.id, name=tag_name))

    if children:
        session.add_all(children)

    await session.commit()
    # One round-trip with selectin relations instead of N×refresh after commit.
    event_ids = [event.id for event in events]
    refreshed = await session.execute(select(Event).where(Event.id.in_(event_ids)))
    by_id = {event.id: event for event in refreshed.scalars().all()}
    ordered_events = [by_id[event_id] for event_id in event_ids]
    await attach_event_field_variable_values(session, ordered_events)
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())
    return ordered_events
