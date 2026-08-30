import json
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
from tripl.core.name_template import (
    VARIABLE_TOKEN_PATTERN,
    apply_name_format,
    resolve_dotted_keys,
)
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.event import Event, EventStatus
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
from tripl.services._event_reference_cleanup import drop_dangling_event_references
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug
from tripl.services.scan_config_lookup import load_governing_scan_configs
from tripl.services.schema_drift_service import get_drift_counts_by_event_type
from tripl.services.search_service import (
    _queue_embedding_refresh,
    _reindex_branch_documents,
)
from tripl.services.variable_value_service import attach_event_field_variable_values

_TRACKED_FIELDS = ("status", "name", "description", "sunset_at")
# One ``${token}`` grammar for the codebase; this module's spelling is the one
# it standardised on (``core.name_template``).
_TEMPLATE_TOKEN_PATTERN = VARIABLE_TOKEN_PATTERN
_JSON_TEMPLATE_TOKEN_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
_JSON_TEMPLATE_VALUE_PATTERN = re.compile(
    r'"\$\{[A-Za-z_][A-Za-z0-9_.-]*\}"|\$\{[A-Za-z_][A-Za-z0-9_.-]*\}'
)


def _normalize_json_template_value(field: FieldDefinition, value: str) -> str:
    """Validate and canonically dump JSON while preserving ``${variable}`` values.

    Template values may occupy a complete JSON value either with quotes or
    without them.  Temporarily replacing them with distinct JSON strings lets
    ``json.loads`` validate the surrounding JSON; restoring the original token
    after ``json.dumps`` keeps the authored template intact.
    """
    tokens = [match.group(1) for match in _TEMPLATE_TOKEN_PATTERN.finditer(value)]
    if any(not _JSON_TEMPLATE_TOKEN_NAME_PATTERN.fullmatch(token) for token in tokens):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Field '{field.display_name}' has an invalid variable token; "
                "use letters, digits, underscores, dots, or hyphens"
            ),
        )

    placeholders: dict[str, str] = {}

    def _stash(match: re.Match[str]) -> str:
        sentinel = f"__TRIPL_JSON_TEMPLATE_{uuid.uuid4().hex}__"
        while sentinel in value or sentinel in placeholders:
            sentinel = f"__TRIPL_JSON_TEMPLATE_{uuid.uuid4().hex}__"
        placeholders[sentinel] = match.group(0)
        return f'"{sentinel}"'

    def _reject_nonstandard_constant(constant: str) -> None:
        raise ValueError(f"{constant} is not valid JSON")

    def _has_template_key(node: object) -> bool:
        if isinstance(node, list):
            return any(_has_template_key(item) for item in node)
        if isinstance(node, dict):
            return any(key in placeholders or _has_template_key(item) for key, item in node.items())
        return False

    try:
        safe_value = _JSON_TEMPLATE_VALUE_PATTERN.sub(_stash, value)
        if len(placeholders) != len(tokens):
            raise ValueError("Variable templates must occupy a complete JSON value")
        parsed = json.loads(safe_value, parse_constant=_reject_nonstandard_constant)
        if _has_template_key(parsed):
            raise ValueError("Variable templates cannot be JSON object keys")
    except (json.JSONDecodeError, TypeError, ValueError, RecursionError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Field '{field.display_name}' must contain valid JSON: {exc}",
        ) from exc

    def _dump(node: object) -> str:
        if isinstance(node, str):
            return placeholders.get(node, json.dumps(node, ensure_ascii=False))
        if isinstance(node, list):
            return "[" + ", ".join(_dump(item) for item in node) + "]"
        if isinstance(node, dict):
            return (
                "{"
                + ", ".join(
                    f"{json.dumps(key, ensure_ascii=False)}: {_dump(item)}"
                    for key, item in node.items()
                )
                + "}"
            )
        return json.dumps(node, ensure_ascii=False, allow_nan=False)

    try:
        return _dump(parsed)
    except RecursionError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Field '{field.display_name}' must contain valid JSON: nesting is too deep",
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Field '{field.display_name}' must contain valid JSON: {exc}",
        ) from exc


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
    event.warnings = [f"Unknown variable token: ${{{token}}}" for token in sorted(unknown_tokens)]  # type: ignore[attr-defined]


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
) -> list[EventFieldValueIn]:
    result = await session.execute(
        select(FieldDefinition).where(FieldDefinition.event_type_id == event_type_id)
    )
    field_defs = {fd.id: fd for fd in result.scalars().all()}

    provided_ids = {fv.field_definition_id for fv in field_values}
    for fd_id, fd in field_defs.items():
        if fd.is_required and fd_id not in provided_ids:
            raise HTTPException(status_code=422, detail=f"Required field '{fd.name}' is missing")
    normalized_values: list[EventFieldValueIn] = []
    for fv in field_values:
        if fv.field_definition_id not in field_defs:
            raise HTTPException(
                status_code=422, detail=f"Field definition {fv.field_definition_id} not found"
            )
        field = field_defs[fv.field_definition_id]
        normalized_values.append(
            fv.model_copy(
                update={
                    "value": _normalize_json_template_value(field, fv.value)
                    if field.field_type == "json"
                    else fv.value
                }
            )
        )
    return normalized_values


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
    reviewed: bool | None = None,
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
    else:
        # Archiving an event is the user asking for it to be out of the way, so
        # an unfiltered listing must not carry it. Only the web app used to
        # honour that, and by accident: it sends an explicit six-status filter,
        # which happens to omit `archived`. Every other consumer of this
        # endpoint — the CLI, the MCP server's `list_events` tool, any direct
        # API call — still got archived events back, so "archived" meant
        # "hidden in one client" rather than a property of the plan (tripl-mhhi).
        # Asking for them explicitly (`?status=archived`) still works.
        query = query.where(Event.status != EventStatus.archived)
        count_query = count_query.where(Event.status != EventStatus.archived)
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
    if reviewed is not None:
        # Independent of `status`: this narrows by the review FLAG, so
        # ?status=in_review&reviewed=false answers "what is still unreviewed in
        # the queue" — the question the review tab could not ask (tripl-invv).
        query = query.where(Event.reviewed.is_(reviewed))
        count_query = count_query.where(Event.reviewed.is_(reviewed))
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
        ordered_query = query.outerjoin(volume_subq, volume_subq.c.event_id == Event.id).order_by(
            func.coalesce(volume_subq.c.volume, 0).desc(), Event.id.asc()
        )
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


async def _resolve_event_name_format(
    session: AsyncSession,
    project_id: uuid.UUID,
    event_type_id: uuid.UUID,
) -> str | None:
    """The scan rule governing names for this event type, if any.

    Which configs are in scope is ``scan_config_lookup.load_governing_scan_configs``
    — shared with the schema-drift guard so the two cannot disagree about
    reachability (tripl-3mmh). The tie-break below is this function's own policy:
    a config bound to the exact event type wins over project-wide (NULL
    event_type_id) configs, and ties break on the most recently updated config.
    """
    rows = await load_governing_scan_configs(
        session, project_id=project_id, event_type_id=event_type_id
    )
    if not rows:
        return None
    exact = [row for row in rows if row.event_type_id == event_type_id]
    pool = exact or rows
    pool.sort(key=lambda row: row.updated_at, reverse=True)
    return pool[0].event_name_format


async def _generate_scan_template_name(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    event_type_id: uuid.UUID,
    field_values: list[EventFieldValueIn],
) -> str | None:
    """Name generated from the governing scan rule, or None when unruled.

    Manual events must carry the same identity the scan will derive from row
    values, or they never merge with their scan-generated counterparts —
    that's why the template, not the user, decides the name. 422 when the
    template references fields the payload doesn't fill.
    """
    name_format = await _resolve_event_name_format(session, project_id, event_type_id)
    if not name_format:
        return None
    field_names = {
        fd.id: fd.name
        for fd in (
            await session.execute(
                select(FieldDefinition).where(FieldDefinition.event_type_id == event_type_id)
            )
        ).scalars()
    }
    values_by_field = {
        field_names[fv.field_definition_id]: fv.value
        for fv in field_values
        if fv.field_definition_id in field_names and fv.value
    }
    resolved = resolve_dotted_keys(name_format, values_by_field)
    generated, missing = apply_name_format(name_format, resolved)
    if missing:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Event name is generated by the scan rule '{name_format}'; "
                f"fill field values for: {', '.join(sorted(set(missing)))}"
            ),
        )
    return generated


async def create_event(
    session: AsyncSession,
    slug: str,
    data: EventCreate,
    branch_id: uuid.UUID | None = None,
) -> Event:
    is_main = branch_id is None
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    field_values = await _validate_field_values(session, data.event_type_id, data.field_values)
    generated_name = await _generate_scan_template_name(
        session,
        project_id=project_id,
        event_type_id=data.event_type_id,
        field_values=field_values,
    )

    event = Event(
        project_id=project_id,
        branch_id=branch_id,
        event_type_id=data.event_type_id,
        name=generated_name or data.name,
        # Scan dedup keys on source_name: stamping the generated identity here
        # is what makes the manual event merge with its scanned counterpart.
        source_name=generated_name,
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

    for fv in field_values:
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
    await _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
    await session.refresh(event)
    await attach_event_field_variable_values(session, [event])
    await _attach_template_warnings(session, event)
    if generated_name and data.name and data.name != generated_name:
        event.warnings = [  # type: ignore[attr-defined]
            *event.warnings,  # type: ignore[attr-defined]
            f"Event name was generated from the scan rule: '{generated_name}'"
            f" (provided name '{data.name}' was ignored)",
        ]
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
        field_values = await _validate_field_values(session, event.event_type_id, data.field_values)
        # VariableValue rows are scan-observed contexts keyed by field_definition_id,
        # not by EventFieldValue rows — manual edits must not wipe them.
        await session.execute(delete(EventFieldValue).where(EventFieldValue.event_id == event.id))
        await session.flush()
        if field_values:
            session.add_all(
                [
                    EventFieldValue(
                        event_id=event.id,
                        field_definition_id=field_value.field_definition_id,
                        value=field_value.value,
                        is_authored=True,
                    )
                    for field_value in field_values
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
    await _queue_embedding_refresh(event_project_id, event_branch_id, ai_config=ai_config)
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
) -> str:
    """Delete one event and hand its name back for the audit record.

    Returning the name follows the precedent in ``variable_service`` and matters
    more here: ``event_changes.event_id`` is ``ondelete="CASCADE"``, so the
    event's own history dies with the row and the audit entry is the only trace
    the delete ever happened (tripl-wkwv.10).
    """
    is_main = branch_id is None
    event = await get_event(session, slug, event_id, branch_id)
    project_id = event.project_id
    resolved_branch_id = event.branch_id
    # Snapshotted for the same reason as the two ids above: the flush below
    # evicts this instance from the identity map and marks it deleted, so it no
    # longer stands for a live row and must not be read afterwards. Not because
    # the read would raise — both session factories are ``expire_on_commit=False``
    # (database.py, tests/conftest.py), so the attribute would in fact still
    # answer; the rule is about not reading a deleted instance.
    event_name = event.name
    # Before the delete: several rows point at this event by string or JSON id,
    # or through a SET NULL foreign key, and would otherwise outlive it. The
    # anomalies are the sharp one — a NULL event_id satisfies every event filter,
    # so deleting an event used to UN-suppress its alerts (tripl-xjuv).
    await drop_dangling_event_references(session, project_id=project_id, event_ids=[event.id])
    await session.delete(event)
    await session.flush()
    _, ai_config = await _reindex_branch_documents(
        session,
        project_id=project_id,
        branch_id=resolved_branch_id,
        slug=slug,
    )
    await session.commit()
    await _queue_embedding_refresh(project_id, resolved_branch_id, ai_config=ai_config)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())
    return event_name


async def bulk_delete_events(
    session: AsyncSession,
    slug: str,
    data: EventBulkDelete,
    branch_id: uuid.UUID | None = None,
) -> list[tuple[uuid.UUID, str]]:
    """Delete the listed events and hand back ``(id, name)`` for each.

    The names are what the audit row keeps: once this returns the ids resolve to
    nothing, so an id-only record of a bulk delete names nothing a reader can
    recognise (tripl-wkwv.10).
    """
    is_main = branch_id is None
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    # Validate all ids exist + belong to this project+branch in a single query,
    # which also collects the names the caller audits — same one round trip the
    # COUNT this replaced cost. The comparison stays against
    # ``len(data.event_ids)`` and NOT the deduplicated set: a request repeating
    # an id matches fewer rows than it listed and 404s, exactly as before.
    rows = (
        await session.execute(
            select(Event.id, Event.name).where(
                Event.project_id == project_id,
                Event.branch_id == branch_id,
                Event.id.in_(data.event_ids),
            )
        )
    ).all()
    if len(rows) != len(data.event_ids):
        raise HTTPException(status_code=404, detail="One or more events were not found")
    deleted = [(event_id, name) for event_id, name in rows]

    # Same cleanup as the single delete, and it matters MORE here: this is a
    # Core DELETE, so no ORM cascade runs at all and everything not covered by a
    # database-level FK survives untouched.
    await drop_dangling_event_references(
        session, project_id=project_id, event_ids=list(data.event_ids)
    )
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
    await _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
    if is_main:
        await cache.delete_prefix(cache.prefix_projects())
    return deleted


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
    await _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
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
        select(FieldDefinition).where(FieldDefinition.event_type_id.in_(unique_event_type_ids))
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
    await _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
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
