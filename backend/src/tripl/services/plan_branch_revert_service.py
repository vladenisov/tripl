"""Revert one change in a plan branch back to the branch's base snapshot.

A branch's diff is computed against the snapshot taken when the branch was
created (``PlanBranch.base_revision_id``), so "revert" has one meaning here:
make this entity — or this one field of it — look like it did in that snapshot.
An entity the branch added is deleted; a field the branch edited is written back
to its base value; an entity the branch deleted is rebuilt from the snapshot,
child rows and all.

One "deletion" is not one: a rename shows up as a removal of the old name plus
an addition of the new one, because the diff keys entities by name. Where the
base row carried a scan identity, reverting that removal moves the name back
onto the row that is still there rather than inserting a second copy of it —
see ``_row_renamed_from`` (tripl-hjxy). A second copy is what
``uq_variable_project_source_name`` and ``uq_event_scan_identity`` refuse
outright; the rename is what keeps the surviving row's history.

That precondition is worth stating rather than implying, because it is the
common case that fails it: ``source_name`` is NULL for every API-created
variable (``VariableCreate`` accepts no such field) and for every event whose
type carries no scan name template, and a removal with no identity to recognise
is rebuilt from the snapshot like any other — including when it was really a
rename, which then reverts as a delete plus an insert.

Order matters when a whole subtree was deleted: an event type comes back before
the fields and events that hang off it, because the snapshot references them by
name and there is nothing to attach them to until the parent exists. The service
says so instead of guessing.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.models.event import Event, EventStatus
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
from tripl.services._event_reference_cleanup import drop_dangling_event_references
from tripl.services.project_lookup import get_project_by_slug
from tripl.services.variable_service import rewrite_variable_token_references

logger = logging.getLogger(__name__)

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


def _required(base_item: dict[str, Any], key: str) -> Any:
    """A value the entity cannot be rebuilt without.

    Snapshots gain fields over time, and a branch opened before a field existed
    has a base payload without it. For a value with no sensible default (a name,
    a type) the honest answer is to refuse: guessing would rebuild the entity as
    something the base never described.
    """
    if key not in base_item:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This branch's base snapshot predates '{key}', so the entity cannot be "
                "rebuilt from it. Recreate it by hand, or open a fresh branch from main."
            ),
        )
    return base_item[key]


def _one(rows: list[Any], data: BranchRevertRequest) -> Any:
    """The single row a diff entry refers to.

    Events and relations carry no uniqueness constraint on the name the diff
    keys them by, so two rows can answer to one entry. Writing to an arbitrary
    one of them would silently clobber a sibling the reviewer never looked at.
    """
    if not rows:
        raise HTTPException(status_code=404, detail="Entity not found on this branch")
    if len(rows) > 1:
        where = f" in {data.parent}" if data.parent else ""
        raise HTTPException(
            status_code=409,
            detail=(
                f"More than one {data.entity_type.replace('_', ' ')} on this branch is called "
                f"'{data.name}'{where}, so it is ambiguous which one this change belongs to. "
                "Rename one of them, then revert."
            ),
        )
    return rows[0]


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


async def _doomed_event_ids(
    session: AsyncSession, entity_type: str, entity: object
) -> list[uuid.UUID]:
    """The events that will disappear when *entity* is deleted.

    An ``event`` is itself; an ``event_type`` takes its events with it through
    the database cascade — ``EventType`` maps no ``events`` relationship, so
    nothing in the ORM reports those rows going. Every other entity type kills
    no events at all.
    """
    if entity_type == "event":
        return [entity.id]  # type: ignore[attr-defined]
    if entity_type == "event_type":
        return list(
            (
                await session.execute(
                    select(Event.id).where(Event.event_type_id == entity.id)  # type: ignore[attr-defined]
                )
            )
            .scalars()
            .all()
        )
    return []


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
        return _one(
            [
                relation
                for relation in relations
                if _relation_name(
                    relation.source_event_type.name,
                    relation.source_field.name,
                    relation.target_event_type.name,
                    relation.target_field.name,
                )
                == data.name
            ],
            data,
        )

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

    return _one(list((await session.execute(query)).scalars().all()), data)


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
    event_by_key: dict[tuple[str, str], Event] = {}
    ambiguous: set[tuple[str, str]] = set()
    for event, et_name in rows:
        key = (et_name, event.name)
        if key in event_by_key:
            ambiguous.add(key)
        event_by_key[key] = event
    base_overrides = base_item.get("event_value_overrides") or []
    # Overrides point at their event by name, and event names are not unique —
    # attaching one to an arbitrary namesake would silently override the wrong
    # event's values.
    clashing = sorted(
        f"{o['event_type_name']}.{o['event_name']}"
        for o in base_overrides
        if (o["event_type_name"], o["event_name"]) in ambiguous
    )
    if clashing:
        raise HTTPException(
            status_code=409,
            detail=(
                f"More than one event on this branch is called {', '.join(clashing)}, so the "
                "override cannot be attached unambiguously. Rename one of them, then revert."
            ),
        )
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


async def _event_type_by_name(
    session: AsyncSession, project_id: uuid.UUID, branch_id: uuid.UUID, name: str
) -> EventType:
    event_type = (
        await session.execute(
            select(EventType).where(
                EventType.project_id == project_id,
                EventType.branch_id == branch_id,
                EventType.name == name,
            )
        )
    ).scalar_one_or_none()
    if event_type is None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Event type '{name}' does not exist on this branch. "
                "Restore it first, then restore what hangs off it."
            ),
        )
    return event_type


def _base_identity_count(
    base_payload: dict[str, Any], data: BranchRevertRequest, source_name: str
) -> int:
    """How many rows in the BASE snapshot claim *source_name* in this scope.

    The scope is ``_sole_key_by_identity``'s ``key[:-1]``: the event type for an
    event, nothing at all for a variable. Read straight off the payload the
    caller already holds — ``build_plan_snapshot`` records ``event_type_name``,
    ``name`` and ``source_name`` on both sets — so asking costs no extra query.
    """
    if data.entity_type == "variable":
        base_variables: list[dict[str, Any]] = base_payload.get("variables", [])
        return sum(1 for item in base_variables if item.get("source_name") == source_name)
    return sum(
        1
        for item in base_payload.get("events", [])
        if item.get("source_name") == source_name and item.get("event_type_name") == data.parent
    )


async def _row_renamed_from(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    data: BranchRevertRequest,
    base_item: dict[str, Any],
    base_payload: dict[str, Any],
) -> Any | None:
    """The branch row that IS this "deleted" entity, still alive under a new name.

    A branch rename renders in the diff as a removal of the old name plus an
    addition of the new one, because the diff keys entities by name. Reverting
    the removal by INSERTING the base row is then wrong twice over: the branch
    already holds that row, and it still carries the row's ``source_name`` — the
    deep copy brought it over and ``update_variable`` / ``update_event`` never
    rewrite it. For a Variable that second copy violates
    ``uq_variable_project_source_name`` and the commit came back as a bare 500;
    for an Event, which at the time had only an index on ``(project,
    event_type, source_name)``, nothing stopped it and the branch was quietly
    left with two rows claiming one scan identity — which the next scan matched
    arbitrarily and which ``pair_renames`` then refused to pair for ever after
    (tripl-hjxy). ``uq_event_scan_identity`` now refuses the event copy too
    (tripl-8tdl), and ``revert_change`` turns that into a 409 — so the worst
    case is a refused revert, not a corrupted branch; the rename below is still
    the right answer because it keeps the row.

    So the honest revert of that removal is to move the row's NAME back, and this
    finds the row to move. Nothing is deleted and nothing is inserted: the id
    survives, and with it the observed values, per-event overrides and drift
    history that hang off it — which reverting the ADDED half would have
    cascaded away.

    Reading ``source_name`` as proof of identity is safe because no client can
    set one: ``VariableCreate`` and ``EventCreate`` do not accept the field,
    ``create_variable`` leaves it null and ``create_event`` stamps it from the
    generated name, so a branch row wearing a DIFFERENT name and the base row's
    ``source_name`` can only be that row, renamed. A base row with no
    ``source_name`` identifies nothing and falls through to the plain rebuild,
    exactly as ``pair_renames`` leaves it unpaired — and so does an identity
    that EITHER side names more than once, which is ``_sole_key_by_identity``'s
    both-sides rule; the two counts below say why each is refused the way it is.

    This deliberately does NOT call ``pair_renames``: that answers "will the
    merge pair these?", which also depends on main, and a revert touches only the
    branch. A rename main happens to have raced is still a rename here.
    """
    source_name = base_item.get("source_name")
    if not source_name:
        return None

    if data.entity_type not in ("variable", "event"):
        # No other entity kind carries a scan identity at all — the snapshot
        # records ``source_name`` on variables and events and nowhere else — so
        # for them a removal is always a removal.
        return None

    # Ambiguity is refused on BOTH sides, which is ``_sole_key_by_identity``'s
    # rule and was only half-applied here: the branch-side count below was
    # checked and the base-side one was not. When this was written events
    # carried no uniqueness on ``source_name`` (only ``ix_events_source_identity``)
    # while ``create_event`` stamps it from the generated name, so main could
    # legitimately hold two events sharing one scan identity under one type —
    # create ``checkout:start``, rename it to ``checkout:begin``, create
    # ``checkout:start`` again. Cut a branch, delete ``checkout:begin`` on it,
    # revert that removal: exactly one branch row carries the identity, nothing
    # below trips, and the revert renames the LIVE ``checkout:start`` to
    # ``checkout:begin``. The deleted event is never restored and an unrelated
    # one silently loses its name.
    #
    # Declining (rather than the 409 the branch side raises) is the right answer
    # for this side: two base rows against one branch row means one was really
    # deleted while the other stayed put, so the plain rebuild restores exactly
    # what went missing. Neither arm can fire from live rows today —
    # ``uq_variable_project_source_name`` makes a variable's identity singular
    # per branch and ``uq_event_scan_identity`` an event's singular per type
    # (tripl-8tdl), and the base IS one branch's snapshot — and both are written
    # anyway, because this reads a stored payload, a snapshot from before the
    # event constraint existed can still name one identity twice, and a payload
    # is data, not a constraint (tripl-hjxy).
    if _base_identity_count(base_payload, data, source_name) > 1:
        return None

    if data.entity_type == "variable":
        query: Any = select(Variable).where(
            Variable.project_id == project_id,
            Variable.branch_id == branch_id,
            Variable.source_name == source_name,
        )
    else:
        # Scoped to the event type, like the identity scope ``pair_renames``
        # uses: two events under different types may share a ``source_name``, and
        # only one under THIS type can be the row that moved.
        query = (
            select(Event)
            .join(EventType, Event.event_type_id == EventType.id)
            .where(
                Event.project_id == project_id,
                Event.branch_id == branch_id,
                Event.source_name == source_name,
                EventType.name == data.parent,
            )
        )

    rows = list((await session.execute(query)).scalars().all())
    if not rows:
        return None
    if len(rows) > 1:
        # Unreachable from live rows: ``uq_variable_project_source_name`` makes
        # it impossible for variables, and ``uq_event_scan_identity`` for events
        # (the branch-and-type scope above is one ``event_type_id``, by
        # ``uq_event_type_project_name``). Kept as the same kind of guard as the
        # base-side count — this is the row the query returned, not a schema
        # promise — because guessing which row moved would rename a sibling the
        # reviewer never looked at, the same reason ``_one`` refuses.
        raise HTTPException(
            status_code=409,
            detail=(
                f"More than one event in '{data.parent}' on this branch carries the scan "
                f"identity '{source_name}', so it is ambiguous which one '{data.name}' was "
                "renamed into. Rename one of them by hand, then revert."
            ),
        )
    return rows[0]


async def _recreate_entity(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    data: BranchRevertRequest,
    base_item: dict[str, Any],
) -> None:
    """Put back an entity the branch deleted, from its state in the base snapshot.

    Reached once ``_row_renamed_from`` has declined to call the removal a
    rename, and it declines in two different shapes. Either it LOOKED and found
    no branch row still carrying the base row's scan identity, in which case the
    insert below is a genuine rebuild rather than a duplicate of a renamed row
    (tripl-hjxy); or the base row carried no ``source_name`` to look for, in
    which case nothing was ruled out and a rename of such a row does arrive here
    and revert as a delete plus an insert. The second shape is the common one:
    ``source_name`` is NULL for every API-created variable and for every event
    under a type with no scan name template.

    Only the entity the diff entry names is recreated, plus the child rows that
    have no diff entry of their own (an event's values and tags, a variable's
    overrides). An event type's fields and events are separate entries, so they
    are restored by their own reverts — in that order, since a field cannot hang
    off an event type that is still missing.

    One gap is deliberate and visible: an event's photos are not restored. The
    snapshot redacts their storage keys, so the rows cannot be rebuilt — and the
    diff keeps showing the photos as missing afterwards rather than pretending
    the restore was complete.

    Identity fields (a name, a type) come through ``_required``: an old base
    snapshot that predates one of them can't describe the entity, and refusing
    beats rebuilding it as something the base never said. Everything with a
    column default falls back to that default, which is also what the diff
    assumes for an older base.
    """
    if data.entity_type == "event_type":
        session.add(
            EventType(
                id=uuid.uuid4(),
                project_id=project_id,
                branch_id=branch_id,
                name=_required(base_item, "name"),
                display_name=_required(base_item, "display_name"),
                description=base_item.get("description"),
                color=base_item.get("color"),
                order=base_item.get("order", 0),
            )
        )
        return

    if data.entity_type == "field_definition":
        event_type = await _event_type_by_name(session, project_id, branch_id, str(data.parent))
        session.add(
            FieldDefinition(
                id=uuid.uuid4(),
                event_type_id=event_type.id,
                name=_required(base_item, "name"),
                display_name=_required(base_item, "display_name"),
                field_type=_required(base_item, "field_type"),
                is_required=base_item.get("is_required", False),
                enum_options=list(base_item["enum_options"])
                if base_item.get("enum_options")
                else None,
                description=base_item.get("description"),
                order=base_item.get("order", 0),
                sensitivity=_required(base_item, "sensitivity"),
                contract_required_max_null_rate=base_item.get("contract_required_max_null_rate"),
                contract_regex=base_item.get("contract_regex"),
                contract_min_value=base_item.get("contract_min_value"),
                contract_max_value=base_item.get("contract_max_value"),
                contract_max_bad_rate=base_item.get("contract_max_bad_rate") or 0.0,
            )
        )
        return

    if data.entity_type == "event":
        event_type = await _event_type_by_name(
            session, project_id, branch_id, _required(base_item, "event_type_name")
        )
        sunset_at = base_item.get("sunset_at")
        owner_id = base_item.get("owner_id")
        event = Event(
            id=uuid.uuid4(),
            project_id=project_id,
            branch_id=branch_id,
            event_type_id=event_type.id,
            name=_required(base_item, "name"),
            source_name=base_item.get("source_name"),
            description=base_item.get("description") or "",
            order=base_item.get("order", 0),
            # A base snapshot older than the status field describes an event with
            # no status; the column's own default is the same answer the diff
            # gives for that older base, so it stays consistent either way.
            status=base_item.get("status") or EventStatus.draft,
            sunset_at=datetime.fromisoformat(sunset_at) if sunset_at else None,
            owner_id=uuid.UUID(owner_id) if owner_id else None,
            reviewed=base_item.get("reviewed", False),
            metric_breakdown_columns=list(base_item.get("metric_breakdown_columns") or []),
        )
        session.add(event)
        await session.flush()
        for field in ("field_values", "meta_values", "tags"):
            await _restore_event_children(session, project_id, branch_id, event, base_item, field)
        return

    if data.entity_type == "variable":
        variable = Variable(
            id=uuid.uuid4(),
            project_id=project_id,
            branch_id=branch_id,
            name=_required(base_item, "name"),
            source_name=base_item.get("source_name"),
            variable_type=_required(base_item, "variable_type"),
            description=base_item.get("description") or "",
            allowed_values=list(base_item.get("allowed_values") or []),
            bindings=list(base_item.get("bindings") or []),
            excluded_from_scans=base_item.get("excluded_from_scans", False),
        )
        session.add(variable)
        await session.flush()
        await _restore_variable_overrides(session, project_id, branch_id, variable, base_item)
        return

    if data.entity_type == "meta_field":
        session.add(
            MetaFieldDefinition(
                id=uuid.uuid4(),
                project_id=project_id,
                branch_id=branch_id,
                name=_required(base_item, "name"),
                display_name=_required(base_item, "display_name"),
                field_type=_required(base_item, "field_type"),
                is_required=base_item.get("is_required", False),
                enum_options=list(base_item["enum_options"])
                if base_item.get("enum_options")
                else None,
                default_value=base_item.get("default_value"),
                link_template=base_item.get("link_template"),
                order=base_item.get("order", 0),
                sensitivity=_required(base_item, "sensitivity"),
            )
        )
        return

    source_et = await _event_type_by_name(
        session, project_id, branch_id, _required(base_item, "source_event_type_name")
    )
    target_et = await _event_type_by_name(
        session, project_id, branch_id, _required(base_item, "target_event_type_name")
    )
    fields = (
        (
            await session.execute(
                select(FieldDefinition).where(
                    FieldDefinition.event_type_id.in_([source_et.id, target_et.id])
                )
            )
        )
        .scalars()
        .all()
    )
    field_by_key = {(fd.event_type_id, fd.name): fd for fd in fields}
    source_field = field_by_key.get((source_et.id, _required(base_item, "source_field_name")))
    target_field = field_by_key.get((target_et.id, _required(base_item, "target_field_name")))
    if source_field is None or target_field is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "The fields this relation joins no longer exist on this branch. Restore them first."
            ),
        )
    session.add(
        EventTypeRelation(
            id=uuid.uuid4(),
            project_id=project_id,
            branch_id=branch_id,
            source_event_type_id=source_et.id,
            target_event_type_id=target_et.id,
            source_field_id=source_field.id,
            target_field_id=target_field.id,
            relation_type=_required(base_item, "relation_type"),
            description=base_item.get("description") or "",
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


async def _apply_revert(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    data: BranchRevertRequest,
    entry: PlanDiffEntry,
    base_payload: dict[str, Any],
) -> None:
    """Make the one change the revert asks for, and commit nothing.

    Split out of ``revert_change`` so all three arms share a single answer for a
    write the database refuses — see the handler there.
    """
    if entry.kind == "removed":
        if data.field is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "This entity was deleted on the branch, so its fields cannot be reverted "
                    "one by one. Revert the whole entity to bring it back."
                ),
            )
        base_item = _base_item(base_payload, data)
        # A removal that is really the old half of a rename puts the name back on
        # the row that moved; rebuilding it from the snapshot would duplicate a
        # row the branch still has (tripl-hjxy). Every other field the branch
        # edited on that row stays, and surfaces as its own ``changed`` entry
        # once the name no longer hides it.
        renamed = await _row_renamed_from(
            session, project_id, branch_id, data, base_item, base_payload
        )
        if renamed is not None:
            if data.entity_type == "variable":
                # Moving the name back is only half of undoing a rename. Saving
                # the rename rewrote every ``${old_name}`` in this branch's
                # stored values to ``${new_name}``
                # (``variable_service.update_variable``), and leaving that
                # standing hands the reviewer a variable answering to the base
                # name while every field and meta value on the branch still
                # names a token NO variable answers to — which
                # ``event_service._attach_template_warnings`` renders as
                # "Unknown variable token" on each affected event, and which a
                # merge then carries to main. The same helper run in the
                # opposite direction, and run BEFORE the assignment below,
                # because it reads the branch name off the row.
                #
                # Variables only, and deliberately: a ``${token}`` names a
                # Variable and nothing else — ``_attach_template_warnings``
                # resolves tokens against Variable rows alone — so the event arm
                # of this revert has no references to carry and needs no rewrite
                # (tripl-hjxy).
                await rewrite_variable_token_references(
                    session,
                    project_id=project_id,
                    branch_id=branch_id,
                    old_name=renamed.name,
                    new_name=data.name,
                )
            renamed.name = data.name
            return
        await _recreate_entity(session, project_id, branch_id, data, base_item)
        return

    if entry.kind == "added":
        if data.field is not None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "This entity was added on the branch, so its fields have no base value. "
                    "Revert the whole entity instead."
                ),
            )
        entity = await _find_entity(session, project_id, branch_id, data)
        # Reverting an "added" entity deletes it outright — no survivor — so the
        # references to it are DROPPED, the same rule the CRUD delete doors use.
        # An event_type takes its events with it through the database cascade
        # that no service can see, which is why it is expanded here (tripl-a64t).
        await drop_dangling_event_references(
            session,
            project_id=project_id,
            event_ids=await _doomed_event_ids(session, data.entity_type, entity),
        )
        await session.delete(entity)
        return

    changed_fields = [change.field for change in entry.field_changes]
    if data.field is not None and data.field not in changed_fields:
        raise HTTPException(status_code=404, detail=f"'{data.field}' did not change on this branch")
    fields = [data.field] if data.field is not None else changed_fields

    entity = await _find_entity(session, project_id, branch_id, data)
    base_item = _base_item(base_payload, data)
    for field in fields:
        await _restore_field(session, project_id, branch_id, entity, base_item, data, field)


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
    # Bound to a plain local BEFORE the first write, and ``branch_id`` used below
    # in place of ``branch.id`` for the same reason. A failed flush rolls back to
    # the root transaction and expires every ORM state on the way, primary keys
    # included, so reading ``project.id`` inside the handler would fire an
    # expired-attribute reload — implicit IO on the sync Session from async code,
    # i.e. ``MissingGreenlet``, and the bare 500 this handler exists to replace.
    # ``plan_branch_merge_service._commit_merged_plan`` learned this the hard way.
    project_id = project.id
    base_payload = await _base_payload(session, branch)

    diff = await plan_branch_service.diff_branch(session, slug, branch_id)
    entry = _find_entry(diff, data)

    try:
        await _apply_revert(session, project_id, branch_id, data, entry, base_payload)
        await session.commit()
    except IntegrityError as exc:
        # A revert can only break a uniqueness rule by putting a name or a scan
        # identity somewhere another row already has it. The shape that actually
        # happened — reverting the removed half of a rename — is settled above by
        # ``_row_renamed_from``, and the diff proves the base name itself is free,
        # so what reaches here is a race against a concurrent edit or a shape we
        # have not modelled. It is still the user's revert that cannot proceed,
        # and 409 says so; the constraint's own text stays in the log for an
        # operator to read against the request id rather than in a response body
        # that would leak the schema (tripl-hjxy).
        await session.rollback()
        # Plain locals only — see the note above the try.
        logger.exception(
            "Revert of %s '%s' on branch %s was rejected by a database constraint",
            data.entity_type,
            data.name,
            branch_id,
        )
        raise HTTPException(
            status_code=409,
            detail=(
                f"Reverting '{data.name}' would leave two rows on this branch with the same "
                "name or the same scan identity. Reload the branch diff and try again — if it "
                "persists, rename the clashing entity first."
            ),
        ) from exc
    return await plan_branch_service.diff_branch(session, slug, branch_id)
