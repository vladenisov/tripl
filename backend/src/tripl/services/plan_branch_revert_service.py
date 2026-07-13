"""Revert one change in a plan branch back to the branch's base snapshot.

A branch's diff is computed against the snapshot taken when the branch was
created (``PlanBranch.base_revision_id``), so "revert" has one meaning here:
make this entity — or this one field of it — look like it did in that snapshot.
An entity the branch added is deleted; a field the branch edited is written back
to its base value.

Restoring an entity the branch *removed* is the one case not handled: it needs a
writer that materialises rows (with their child collections) out of a snapshot
payload, which nothing in the codebase does yet. It is rejected with a clear
message rather than half-done (tripl-mzsb.3).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_meta_value import EventMetaValue
from tripl.models.event_tag import EventTag
from tripl.models.event_type import EventType
from tripl.models.event_type_relation import EventTypeRelation
from tripl.models.field_definition import FieldDefinition
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.models.plan_branch import BranchKind, BranchStatus, PlanBranch
from tripl.models.plan_revision import PlanRevision
from tripl.models.project import Project
from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.schemas.plan_branch import BranchRevertRequest, PlanBranchDiff
from tripl.schemas.plan_revision import PlanDiffEntry
from tripl.services import plan_branch_service
from tripl.services.project_lookup import get_project_by_slug

# Fields whose base value is a plain column write. Everything else on an entity
# either needs coercion (ids, timestamps) or lives in a child table.
_PLAIN_ATTRS: dict[str, tuple[str, ...]] = {
    "event_type": ("display_name", "description", "color"),
    "field_definition": (
        "field_type",
        "is_required",
        "enum_options",
        "description",
        "sensitivity",
        "contract_required_max_null_rate",
        "contract_regex",
        "contract_min_value",
        "contract_max_value",
        "contract_max_bad_rate",
    ),
    "event": ("source_name", "description", "status", "reviewed", "metric_breakdown_columns"),
    "variable": (
        "variable_type",
        "source_name",
        "description",
        "allowed_values",
        "bindings",
        "excluded_from_scans",
    ),
    "meta_field": (
        "field_type",
        "is_required",
        "enum_options",
        "default_value",
        "link_template",
        "sensitivity",
    ),
    "relation": ("relation_type", "description"),
}


def _relation_name(source_et: str, source_field: str, target_et: str, target_field: str) -> str:
    """The diff's name for a relation — mirrors compute_plan_diff_entries."""
    return f"{source_et}.{source_field} → {target_et}.{target_field}"


async def _load_branch(session: AsyncSession, project: Project, branch_id: uuid.UUID) -> PlanBranch:
    branch = await session.get(PlanBranch, branch_id)
    if branch is None or branch.project_id != project.id:
        raise HTTPException(status_code=404, detail="Branch not found")
    if branch.kind == BranchKind.main:
        raise HTTPException(status_code=400, detail="The live plan has no branch changes to revert")
    if branch.status in (BranchStatus.merged, BranchStatus.closed):
        raise HTTPException(
            status_code=409,
            detail=f"Branch is {branch.status} — reopen it before reverting changes",
        )
    return branch


async def _base_payload(session: AsyncSession, branch: PlanBranch) -> dict[str, Any]:
    """The snapshot a revert restores to.

    Legacy branches opened before base snapshots existed have nothing to restore
    to — their diff is computed against current main, which is a moving target,
    so reverting against it could silently pull in main-side edits.
    """
    revision = (
        await session.get(PlanRevision, branch.base_revision_id)
        if branch.base_revision_id is not None
        else None
    )
    if revision is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "This branch has no base snapshot, so there is nothing to revert to. "
                "Recreate it from current main."
            ),
        )
    return revision.payload or {}


def _find_entry(diff: PlanBranchDiff, data: BranchRevertRequest) -> PlanDiffEntry:
    for entry in diff.entries:
        if (
            entry.entity_type == data.entity_type
            and entry.name == data.name
            and entry.parent == data.parent
        ):
            return entry
    raise HTTPException(status_code=404, detail="That change is not in this branch's diff")


def _base_item(base_payload: dict[str, Any], data: BranchRevertRequest) -> dict[str, Any]:
    """The entity's state in the base snapshot, keyed the way the diff keys it."""
    match: dict[str, Any] | None = None
    if data.entity_type == "event_type":
        match = next(
            (item for item in base_payload.get("event_types", []) if item["name"] == data.name),
            None,
        )
    elif data.entity_type == "field_definition":
        for event_type in base_payload.get("event_types", []):
            if event_type["name"] != data.parent:
                continue
            match = next(
                (fd for fd in event_type.get("field_definitions", []) if fd["name"] == data.name),
                None,
            )
    elif data.entity_type == "event":
        match = next(
            (
                item
                for item in base_payload.get("events", [])
                if item["name"] == data.name and item["event_type_name"] == data.parent
            ),
            None,
        )
    elif data.entity_type == "variable":
        match = next(
            (item for item in base_payload.get("variables", []) if item["name"] == data.name),
            None,
        )
    elif data.entity_type == "meta_field":
        match = next(
            (item for item in base_payload.get("meta_fields", []) if item["name"] == data.name),
            None,
        )
    else:
        match = next(
            (
                item
                for item in base_payload.get("relations", [])
                if _relation_name(
                    item["source_event_type_name"],
                    item["source_field_name"],
                    item["target_event_type_name"],
                    item["target_field_name"],
                )
                == data.name
            ),
            None,
        )
    if match is None:
        raise HTTPException(
            status_code=409,
            detail="The base snapshot does not describe this entity, so it cannot be restored",
        )
    return match


async def _find_entity(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    data: BranchRevertRequest,
) -> Any:
    """The branch-side row the change lives on."""
    if data.entity_type == "relation":
        relations = (
            (
                await session.execute(
                    select(EventTypeRelation)
                    .where(
                        EventTypeRelation.project_id == project_id,
                        EventTypeRelation.branch_id == branch_id,
                    )
                    .options(
                        selectinload(EventTypeRelation.source_event_type),
                        selectinload(EventTypeRelation.target_event_type),
                        selectinload(EventTypeRelation.source_field),
                        selectinload(EventTypeRelation.target_field),
                    )
                )
            )
            .scalars()
            .all()
        )
        match = next(
            (
                relation
                for relation in relations
                if _relation_name(
                    relation.source_event_type.name,
                    relation.source_field.name,
                    relation.target_event_type.name,
                    relation.target_field.name,
                )
                == data.name
            ),
            None,
        )
        if match is None:
            raise HTTPException(status_code=404, detail="Entity not found on this branch")
        return match

    if data.entity_type == "event_type":
        query: Any = select(EventType).where(
            EventType.project_id == project_id,
            EventType.branch_id == branch_id,
            EventType.name == data.name,
        )
    elif data.entity_type == "field_definition":
        query = (
            select(FieldDefinition)
            .join(EventType, FieldDefinition.event_type_id == EventType.id)
            .where(
                EventType.project_id == project_id,
                EventType.branch_id == branch_id,
                EventType.name == data.parent,
                FieldDefinition.name == data.name,
            )
        )
    elif data.entity_type == "event":
        query = (
            select(Event)
            .join(EventType, Event.event_type_id == EventType.id)
            .where(
                Event.project_id == project_id,
                Event.branch_id == branch_id,
                Event.name == data.name,
                EventType.name == data.parent,
            )
            .options(
                selectinload(Event.field_values),
                selectinload(Event.meta_values),
                selectinload(Event.tags),
            )
        )
    elif data.entity_type == "variable":
        query = select(Variable).where(
            Variable.project_id == project_id,
            Variable.branch_id == branch_id,
            Variable.name == data.name,
        )
    else:
        query = select(MetaFieldDefinition).where(
            MetaFieldDefinition.project_id == project_id,
            MetaFieldDefinition.branch_id == branch_id,
            MetaFieldDefinition.name == data.name,
        )

    entity = (await session.execute(query)).scalars().first()
    if entity is None:
        raise HTTPException(status_code=404, detail="Entity not found on this branch")
    return entity


async def _restore_event_children(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    event: Event,
    base_item: dict[str, Any],
    field: str,
) -> None:
    """Rewrite one of an event's child collections from the base snapshot.

    Values reference their field / meta field by name. A name the branch has
    since deleted cannot be restored — the row it would hang off no longer
    exists — so the revert is refused rather than silently dropping the value.
    """
    if field == "field_values":
        fields_by_name = {
            fd.name: fd
            for fd in (
                (
                    await session.execute(
                        select(FieldDefinition).where(
                            FieldDefinition.event_type_id == event.event_type_id
                        )
                    )
                )
                .scalars()
                .all()
            )
        }
        base_values = base_item.get("field_values") or []
        missing = sorted(
            {v["field_name"] for v in base_values if v["field_name"] not in fields_by_name}
        )
        if missing:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Cannot restore values for field(s) {', '.join(missing)} — "
                    "they no longer exist on this branch. Revert the field change first."
                ),
            )
        await session.execute(delete(EventFieldValue).where(EventFieldValue.event_id == event.id))
        for value in base_values:
            session.add(
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fields_by_name[value["field_name"]].id,
                    value=value["value"],
                    is_authored=value.get("is_authored", False),
                )
            )
        return

    if field == "meta_values":
        meta_by_name = {
            mf.name: mf
            for mf in (
                (
                    await session.execute(
                        select(MetaFieldDefinition).where(
                            MetaFieldDefinition.project_id == project_id,
                            MetaFieldDefinition.branch_id == branch_id,
                        )
                    )
                )
                .scalars()
                .all()
            )
        }
        base_values = base_item.get("meta_values") or []
        missing = sorted(
            {v["meta_field_name"] for v in base_values if v["meta_field_name"] not in meta_by_name}
        )
        if missing:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Cannot restore meta value(s) for {', '.join(missing)} — "
                    "the meta field no longer exists on this branch."
                ),
            )
        await session.execute(delete(EventMetaValue).where(EventMetaValue.event_id == event.id))
        for value in base_values:
            session.add(
                EventMetaValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    meta_field_definition_id=meta_by_name[value["meta_field_name"]].id,
                    value=value["value"],
                )
            )
        return

    await session.execute(delete(EventTag).where(EventTag.event_id == event.id))
    for tag in base_item.get("tags") or []:
        session.add(EventTag(id=uuid.uuid4(), event_id=event.id, name=tag))


async def _restore_variable_overrides(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    variable: Variable,
    base_item: dict[str, Any],
) -> None:
    rows = (
        (
            await session.execute(
                select(Event, EventType.name)
                .join(EventType, Event.event_type_id == EventType.id)
                .where(Event.project_id == project_id, Event.branch_id == branch_id)
            )
        )
        .tuples()
        .all()
    )
    event_by_key = {(et_name, event.name): event for event, et_name in rows}
    base_overrides = base_item.get("event_value_overrides") or []
    missing = sorted(
        {
            f"{o['event_type_name']}.{o['event_name']}"
            for o in base_overrides
            if (o["event_type_name"], o["event_name"]) not in event_by_key
        }
    )
    if missing:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot restore overrides for {', '.join(missing)} — "
                "the event no longer exists on this branch."
            ),
        )
    await session.execute(
        delete(VariableEventValueOverride).where(
            VariableEventValueOverride.variable_id == variable.id,
            VariableEventValueOverride.branch_id == branch_id,
        )
    )
    for override in base_overrides:
        event = event_by_key[(override["event_type_name"], override["event_name"])]
        session.add(
            VariableEventValueOverride(
                id=uuid.uuid4(),
                project_id=project_id,
                branch_id=branch_id,
                variable_id=variable.id,
                event_id=event.id,
                values=list(override.get("values") or []),
            )
        )


async def _restore_field(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    entity: Any,
    base_item: dict[str, Any],
    data: BranchRevertRequest,
    field: str,
) -> None:
    if field in _PLAIN_ATTRS[data.entity_type]:
        value = base_item.get(field)
        # Copy JSON list columns so the entity never aliases the snapshot payload.
        setattr(entity, field, list(value) if isinstance(value, list) else value)
        return

    if data.entity_type == "event":
        if field == "sunset_at":
            raw = base_item.get("sunset_at")
            entity.sunset_at = datetime.fromisoformat(raw) if raw else None
            return
        if field == "owner_id":
            raw = base_item.get("owner_id")
            entity.owner_id = uuid.UUID(raw) if raw else None
            return
        if field == "event_type_name":
            event_type = (
                await session.execute(
                    select(EventType).where(
                        EventType.project_id == project_id,
                        EventType.branch_id == branch_id,
                        EventType.name == base_item["event_type_name"],
                    )
                )
            ).scalar_one_or_none()
            if event_type is None:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Cannot move the event back to '{base_item['event_type_name']}' — "
                        "that event type no longer exists on this branch."
                    ),
                )
            entity.event_type_id = event_type.id
            return
        if field in ("field_values", "meta_values", "tags"):
            await _restore_event_children(session, project_id, branch_id, entity, base_item, field)
            return

    if data.entity_type == "variable" and field == "event_value_overrides":
        await _restore_variable_overrides(session, project_id, branch_id, entity, base_item)
        return

    # Photos are the known gap: their bytes live in object storage, so putting a
    # deleted one back is not a plan-snapshot write.
    raise HTTPException(status_code=400, detail=f"Reverting '{field}' is not supported")


async def revert_change(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID,
    data: BranchRevertRequest,
) -> PlanBranchDiff:
    """Undo one entry of a branch's diff — the whole entity, or one field of it.

    Returns the branch's diff after the revert, so the caller renders the result
    without a second round-trip.
    """
    project = await get_project_by_slug(session, slug, detail=f"Project '{slug}' not found")
    branch = await _load_branch(session, project, branch_id)
    base_payload = await _base_payload(session, branch)

    diff = await plan_branch_service.diff_branch(session, slug, branch_id)
    entry = _find_entry(diff, data)

    if entry.kind == "removed":
        raise HTTPException(
            status_code=409,
            detail=(
                "Restoring an entity this branch deleted is not supported yet — "
                "recreate it by hand, or discard the branch."
            ),
        )

    if entry.kind == "added":
        if data.field is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "This entity was added on the branch, so its fields have no base value. "
                    "Revert the whole entity instead."
                ),
            )
        entity = await _find_entity(session, project.id, branch.id, data)
        await session.delete(entity)
        await session.commit()
        return await plan_branch_service.diff_branch(session, slug, branch_id)

    changed_fields = [change.field for change in entry.field_changes]
    if data.field is not None and data.field not in changed_fields:
        raise HTTPException(status_code=404, detail=f"'{data.field}' did not change on this branch")
    fields = [data.field] if data.field is not None else changed_fields

    entity = await _find_entity(session, project.id, branch.id, data)
    base_item = _base_item(base_payload, data)
    for field in fields:
        await _restore_field(session, project.id, branch.id, entity, base_item, data, field)

    await session.commit()
    return await plan_branch_service.diff_branch(session, slug, branch_id)
