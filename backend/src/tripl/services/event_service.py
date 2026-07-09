import re
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import delete, func, or_, select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

from tripl import cache
from tripl.alerting_matching import rule_covers_event
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.event import Event
from tripl.models.event_change import EventChange, create_event_change
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_meta_value import EventMetaValue
from tripl.models.event_metric import EventMetric
from tripl.models.event_tag import EventTag
from tripl.models.field_definition import FieldDefinition
from tripl.models.user import User
from tripl.models.variable import Variable
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
from tripl.services.search_service import (
    _queue_embedding_refresh,
    _reindex_branch_documents,
)
from tripl.services.variable_value_service import attach_event_field_variable_values

_TRACKED_FIELDS = ("status", "name", "description", "sunset_at")
_TEMPLATE_TOKEN_PATTERN = re.compile(r"\$\{([^}]+)\}")


async def _attach_template_warnings(session: AsyncSession, event: Event) -> None:
    """Attach advisory warnings for complete template tokens unknown in the event branch."""
    result = await session.execute(
        select(Variable).where(
            Variable.project_id == event.project_id,
            Variable.branch_id == event.branch_id,
        )
    )
    known_tokens = {
        token
        for variable in result.scalars().all()
        for token in (variable.name, variable.source_name, *(variable.bindings or []))
        if token
    }
    unknown_tokens = {
        match.group(1)
        for value in [
            *(field_value.value for field_value in event.field_values),
            *(meta_value.value for meta_value in event.meta_values),
        ]
        for match in _TEMPLATE_TOKEN_PATTERN.finditer(value)
        if match.group(1) not in known_tokens
    }
    setattr(
        event,
        "warnings",
        [f"Unknown variable token: ${{{token}}}" for token in sorted(unknown_tokens)],
    )


def _record_changes(
    session: AsyncSession,
    *,
    event: Event,
    old_values: dict[str, object],
    new_values: dict[str, object],
    user_id: uuid.UUID | None,
) -> None:
    for field, new_val in new_values.items():
        old_val = old_values.get(field)
        old_str = str(old_val) if old_val is not None else None
        new_str = str(new_val) if new_val is not None else None
        if old_str != new_str:
            session.add(
                create_event_change(
                    event_id=event.id,
                    user_id=user_id,
                    field=field,
                    old_value=old_str,
                    new_value=new_str,
                )
            )


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
    status: list[str] | None = None,
    tag: str | None = None,
    offset: int = 0,
    limit: int = 200,
    silent_since_days: int | None = None,
    field_value: str | None = None,
    meta_value: str | None = None,
    branch_id: uuid.UUID | None = None,
    order_by: str = "catalog",
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
    if status:
        query = query.where(Event.status.in_(status))
        count_query = count_query.where(Event.status.in_(status))
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
    if order_by == "volume":
        # Busiest-first: rank the review queue by each event's total ingested
        # volume over the last 24h (summed EventMetric.count) so high-traffic
        # events surface before quiet ones. Events with no metrics in the window
        # sort last (COALESCE→0 under DESC == NULLS LAST for non-negative counts),
        # with id.asc() as a stable tiebreak.
        cutoff = datetime.now(UTC) - timedelta(hours=24)
        volume_subq = (
            select(
                EventMetric.event_id.label("event_id"),
                func.sum(EventMetric.count).label("volume"),
            )
            .where(EventMetric.event_id.is_not(None), EventMetric.bucket >= cutoff)
            .group_by(EventMetric.event_id)
            .subquery()
        )
        ordered_query = query.outerjoin(
            volume_subq, volume_subq.c.event_id == Event.id
        ).order_by(func.coalesce(volume_subq.c.volume, 0).desc(), Event.id.asc())
    else:
        ordered_query = query.order_by(
            Event.order.asc(),
            Event.created_at.desc(),
            Event.id.asc(),
        )
    result = await session.execute(ordered_query.offset(offset).limit(limit))
    events = list(result.scalars().all())

    # Project SchemaDrift counts (per event_type) onto each event so the API
    # ships drift signal alongside the catalog row without an extra round-trip.
    event_type_ids = list({event.event_type_id for event in events})
    drift_counts = await get_drift_counts_by_event_type(session, project_id, event_type_ids)
    for event in events:
        event.drift_count = drift_counts.get(event.event_type_id, 0)  # type: ignore[attr-defined]

    # Project alert-rule coverage onto each row so the catalog's Monitor column
    # reflects whether an event is watched (has a rule) — the same identity-based
    # coverage the live pipeline uses — not merely whether it is firing.
    coverage_rules = await _load_event_coverage_rules(session, project_id)
    for event in events:
        event.monitored = any(  # type: ignore[attr-defined]
            rule_covers_event(
                rule,
                event_id=event.id,
                event_type_id=event.event_type_id,
            )
            for rule in coverage_rules
        )

    await attach_event_field_variable_values(session, events)
    return events, total


async def _load_event_coverage_rules(
    session: AsyncSession, project_id: uuid.UUID
) -> list[AlertRule]:
    """Enabled, event-scoped alert rules under enabled destinations.

    Only these rules can *cover* an event, so the catalog computes the
    ``monitored`` flag by testing each event against just this set (their
    identity filters) rather than the full rule roster. Filters load eagerly via
    ``AlertRule.filters`` (``lazy="selectin"``), so this is a bounded, two-query
    load regardless of page size.
    """
    result = await session.execute(
        select(AlertRule)
        .join(AlertDestination, AlertDestination.id == AlertRule.destination_id)
        .where(
            AlertDestination.project_id == project_id,
            AlertDestination.enabled.is_(True),
            AlertRule.enabled.is_(True),
            AlertRule.include_events.is_(True),
        )
    )
    return list(result.scalars().unique().all())


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
        status=data.status,
        sunset_at=data.sunset_at,
        owner_id=data.owner_id,
        reviewed=data.reviewed,
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
                is_authored=True,
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

    # Rebuild the search index inside the SAME transaction as the write, then
    # commit once. A single commit keeps primary data and the search index
    # consistent: if the reindex raises, the whole request rolls back together.
    await session.flush()
    _, ai_config = await _reindex_branch_documents(
        session, project_id=project_id, branch_id=branch_id, slug=slug
    )
    await session.commit()
    # Fire the async embedding refresh only after the commit succeeds, so a
    # rolled-back transaction never enqueues a stale refresh.
    _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
    await session.refresh(event)
    await attach_event_field_variable_values(session, [event])
    await _attach_template_warnings(session, event)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())
    return event


async def update_event(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    data: EventUpdate,
    branch_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
) -> Event:
    is_main = branch_id is None
    event = await get_event(session, slug, event_id, branch_id)
    update_data = data.model_dump(exclude_unset=True)

    # Snapshot tracked fields before mutation for change history
    old_values = {f: getattr(event, f) for f in _TRACKED_FIELDS if f in update_data}

    if "name" in update_data:
        event.name = update_data["name"]
    if "description" in update_data:
        event.description = update_data["description"]
    if "status" in update_data:
        event.status = update_data["status"]
    if "sunset_at" in update_data:
        event.sunset_at = update_data["sunset_at"]
    if "metric_breakdown_columns" in update_data:
        event.metric_breakdown_columns = update_data["metric_breakdown_columns"]
    if "owner_id" in update_data:
        event.owner_id = update_data["owner_id"]
    if "reviewed" in update_data:
        event.reviewed = update_data["reviewed"]

    tracked_new = {f: update_data[f] for f in _TRACKED_FIELDS if f in update_data}
    _record_changes(
        session, event=event, old_values=old_values, new_values=tracked_new, user_id=user_id
    )

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
                        is_authored=True,
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

    event_project_id = event.project_id
    event_branch_id = event.branch_id
    await session.flush()
    _, ai_config = await _reindex_branch_documents(
        session,
        project_id=event_project_id,
        branch_id=event_branch_id,
        slug=slug,
    )
    await session.commit()
    _queue_embedding_refresh(event_project_id, event_branch_id, ai_config=ai_config)
    await session.refresh(event)
    await attach_event_field_variable_values(session, [event])
    await _attach_template_warnings(session, event)
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
    await session.flush()
    _, ai_config = await _reindex_branch_documents(
        session,
        project_id=project_id,
        branch_id=resolved_branch_id,
        slug=slug,
    )
    await session.commit()
    _queue_embedding_refresh(project_id, resolved_branch_id, ai_config=ai_config)
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
    await session.flush()
    _, ai_config = await _reindex_branch_documents(
        session, project_id=project_id, branch_id=branch_id, slug=slug
    )
    await session.commit()
    _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())


async def bulk_update_events(
    session: AsyncSession,
    slug: str,
    data: EventBulkUpdate,
    branch_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
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

    # Record changes for each event
    if update_values:
        events_result = await session.execute(
            select(Event).where(
                Event.project_id == project_id,
                Event.branch_id == branch_id,
                Event.id.in_(event_ids),
            )
        )
        for event in events_result.scalars().all():
            old_values = {f: getattr(event, f) for f in _TRACKED_FIELDS if f in update_values}
            _record_changes(
                session,
                event=event,
                old_values=old_values,
                new_values={f: update_values[f] for f in _TRACKED_FIELDS if f in update_values},
                user_id=user_id,
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
    await session.flush()
    _, ai_config = await _reindex_branch_documents(
        session, project_id=project_id, branch_id=branch_id, slug=slug
    )
    await session.commit()
    _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
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

    # Batched per-event-type validation: ONE SELECT across all referenced event
    # types (IN-list), grouped by event_type_id in Python, then a per-event
    # check using the cached field definitions.
    unique_event_type_ids = {data.event_type_id for data in events_data}
    field_defs_by_type: dict[uuid.UUID, dict[uuid.UUID, FieldDefinition]] = {
        event_type_id: {} for event_type_id in unique_event_type_ids
    }
    result = await session.execute(
        select(FieldDefinition).where(
            FieldDefinition.event_type_id.in_(unique_event_type_ids)
        )
    )
    for fd in result.scalars().all():
        field_defs_by_type.setdefault(fd.event_type_id, {})[fd.id] = fd

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
                status=data.status,
                sunset_at=data.sunset_at,
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
                    is_authored=True,
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

    await session.flush()
    _, ai_config = await _reindex_branch_documents(
        session, project_id=project_id, branch_id=branch_id, slug=slug
    )
    await session.commit()
    _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
    # One round-trip with selectin relations instead of N×refresh after commit.
    event_ids = [event.id for event in events]
    refreshed = await session.execute(select(Event).where(Event.id.in_(event_ids)))
    by_id = {event.id: event for event in refreshed.scalars().all()}
    ordered_events = [by_id[event_id] for event_id in event_ids]
    await attach_event_field_variable_values(session, ordered_events)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())
    return ordered_events


async def get_event_history(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> list[dict[str, object]]:
    # Validate event belongs to this project
    await get_event(session, slug, event_id, branch_id)

    result = await session.execute(
        select(EventChange, User.email)
        .outerjoin(User, EventChange.user_id == User.id)
        .where(EventChange.event_id == event_id)
        .order_by(EventChange.created_at.desc())
    )
    rows = result.all()
    history: list[dict[str, object]] = []
    for change, user_email in rows:
        history.append(
            {
                "id": change.id,
                "event_id": change.event_id,
                "user_id": change.user_id,
                "user_email": user_email,
                "field": change.field,
                "old_value": change.old_value,
                "new_value": change.new_value,
                "created_at": change.created_at,
            }
        )
    return history
