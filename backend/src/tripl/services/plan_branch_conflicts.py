from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.plan_branch_merge_resolution import PlanBranchMergeResolution
from tripl.models.plan_revision import PlanRevision
from tripl.schemas.plan_branch import (
    BranchConflictsResponse,
    ConflictEntity,
    ConflictField,
    ResolutionCreate,
    ResolutionResponse,
)
from tripl.services.plan_branch_service import (
    _get_branch,
    _reject_main,
    _resolve_project,
    ensure_main_branch_id,
)
from tripl.services.plan_revision_service import build_plan_snapshot

# --- 3-way merge engine ---------------------------------------------------
#
# base   = snapshot of main at branch open (stored as PlanBranch.base_revision)
# ours   = current main snapshot
# theirs = current branch snapshot
#
# A conflict is "same entity changed on both sides" (vs base). When clean, we
# apply theirs onto main *by natural key* — matched event_types/events keep
# their live ids, so attached runtime rows (metrics/photos/alerts) survive.

_ET_CHANGE_KEYS = ("display_name", "description", "color", "order")
_FD_CHANGE_KEYS = (
    "display_name",
    "field_type",
    "is_required",
    "enum_options",
    "description",
    "order",
    "sensitivity",
)
_EV_CHANGE_KEYS = ("description", "implemented", "reviewed", "archived", "order")
_VAR_CHANGE_KEYS = ("source_name", "variable_type", "description")
_MF_CHANGE_KEYS = (
    "display_name",
    "field_type",
    "is_required",
    "enum_options",
    "default_value",
    "link_template",
    "order",
    "sensitivity",
)
_REL_CHANGE_KEYS = ("relation_type", "description")


def _flatten_fields(payload: dict) -> list[dict]:
    out: list[dict] = []
    for et in payload.get("event_types", []):
        for fd in et.get("field_definitions", []):
            out.append({**fd, "_et": et["name"]})
    return out


def _entity_changed(base_item, new_item, fields) -> bool:
    if (base_item is None) != (new_item is None):
        return True
    if base_item is None:
        return False
    return any(base_item.get(f) != new_item.get(f) for f in fields)


def _entities_equal(a, b, fields) -> bool:
    if (a is None) != (b is None):
        return False
    if a is None:
        return True
    return all(a.get(f) == b.get(f) for f in fields)


def _conflict_set(
    *,
    entity_type: str,
    base_items: list[dict],
    ours_items: list[dict],
    theirs_items: list[dict],
    key_fn,
    name_fn,
    change_keys,
) -> list[dict]:
    base_by = {key_fn(item): item for item in base_items}
    ours_by = {key_fn(item): item for item in ours_items}
    theirs_by = {key_fn(item): item for item in theirs_items}

    conflicts: list[dict] = []
    for key in set(ours_by) | set(theirs_by) | set(base_by):
        b = base_by.get(key)
        o = ours_by.get(key)
        t = theirs_by.get(key)
        ours_changed = _entity_changed(b, o, change_keys)
        theirs_changed = _entity_changed(b, t, change_keys)
        if ours_changed and theirs_changed and not _entities_equal(o, t, change_keys):
            display = name_fn(o or t or b or {})
            conflicts.append({"entity_type": entity_type, "name": display})
    return conflicts


def _event_type_add_remove_conflicts(base: dict, ours: dict, theirs: dict) -> list[dict]:
    """add/remove-class conflicts on event_type — modify-vs-modify is handled
    at field level via _field_conflicts_event_type. Conflict only if BOTH
    sides made a divergent change (one-sided edits auto-merge)."""
    base_by = {e["name"]: e for e in base.get("event_types", [])}
    ours_by = {e["name"]: e for e in ours.get("event_types", [])}
    theirs_by = {e["name"]: e for e in theirs.get("event_types", [])}

    conflicts: list[dict] = []
    for name in set(base_by) | set(ours_by) | set(theirs_by):
        b = base_by.get(name)
        o = ours_by.get(name)
        t = theirs_by.get(name)
        # Modify-vs-modify path lives in _field_conflicts_event_type.
        if b is not None and o is not None and t is not None:
            continue
        ours_changed = _entity_changed(b, o, _ET_CHANGE_KEYS)
        theirs_changed = _entity_changed(b, t, _ET_CHANGE_KEYS)
        if ours_changed and theirs_changed and not _entities_equal(o, t, _ET_CHANGE_KEYS):
            conflicts.append({"entity_type": "event_type", "name": name})
    return conflicts


def _detect_merge_conflicts(base: dict, ours: dict, theirs: dict) -> list[dict]:
    conflicts: list[dict] = []
    conflicts.extend(_event_type_add_remove_conflicts(base, ours, theirs))
    conflicts.extend(
        _conflict_set(
            entity_type="field_definition",
            base_items=_flatten_fields(base),
            ours_items=_flatten_fields(ours),
            theirs_items=_flatten_fields(theirs),
            key_fn=lambda x: (x["_et"], x["name"]),
            name_fn=lambda x: f"{x['_et']}.{x['name']}",
            change_keys=_FD_CHANGE_KEYS,
        )
    )
    conflicts.extend(
        _conflict_set(
            entity_type="event",
            base_items=base.get("events", []),
            ours_items=ours.get("events", []),
            theirs_items=theirs.get("events", []),
            key_fn=lambda x: (x["event_type_name"], x["name"]),
            name_fn=lambda x: f"{x['event_type_name']}.{x['name']}",
            change_keys=_EV_CHANGE_KEYS,
        )
    )
    conflicts.extend(
        _conflict_set(
            entity_type="variable",
            base_items=base.get("variables", []),
            ours_items=ours.get("variables", []),
            theirs_items=theirs.get("variables", []),
            key_fn=lambda x: x["name"],
            name_fn=lambda x: x["name"],
            change_keys=_VAR_CHANGE_KEYS,
        )
    )
    conflicts.extend(
        _conflict_set(
            entity_type="meta_field",
            base_items=base.get("meta_fields", []),
            ours_items=ours.get("meta_fields", []),
            theirs_items=theirs.get("meta_fields", []),
            key_fn=lambda x: x["name"],
            name_fn=lambda x: x["name"],
            change_keys=_MF_CHANGE_KEYS,
        )
    )
    conflicts.extend(
        _conflict_set(
            entity_type="relation",
            base_items=base.get("relations", []),
            ours_items=ours.get("relations", []),
            theirs_items=theirs.get("relations", []),
            key_fn=lambda x: (
                x["source_event_type_name"],
                x["source_field_name"],
                x["target_event_type_name"],
                x["target_field_name"],
            ),
            name_fn=lambda x: (
                f"{x['source_event_type_name']}.{x['source_field_name']}"
                f"->{x['target_event_type_name']}.{x['target_field_name']}"
            ),
            change_keys=_REL_CHANGE_KEYS,
        )
    )
    return conflicts


# --- inline 3-way field conflicts (v1 covers event_type metadata only) -------


def _field_conflicts_event_type(base: dict, ours: dict, theirs: dict) -> list[dict]:
    """Per-field conflicts on event_type metadata.

    Returns one dict per (entity_name, field) where main and the branch both
    changed the value vs base and the two new values disagree. The shape feeds
    the inline-resolution UI: name + field + base/ours/theirs values.
    """
    base_by = {e["name"]: e for e in base.get("event_types", [])}
    ours_by = {e["name"]: e for e in ours.get("event_types", [])}
    theirs_by = {e["name"]: e for e in theirs.get("event_types", [])}

    rows: list[dict] = []
    for name in set(base_by) | set(ours_by) | set(theirs_by):
        b = base_by.get(name)
        o = ours_by.get(name)
        t = theirs_by.get(name)
        # Adds and removes are not field-level — they bubble up to the
        # entity-level _detect_merge_conflicts path. Skip here.
        if b is None or o is None or t is None:
            continue
        for field in _ET_CHANGE_KEYS:
            bv = b.get(field)
            ov = o.get(field)
            tv = t.get(field)
            if ov != bv and tv != bv and ov != tv:
                rows.append(
                    {
                        "entity_type": "event_type",
                        "name": name,
                        "field": field,
                        "base": bv,
                        "ours": ov,
                        "theirs": tv,
                    }
                )
    return rows


async def _load_resolutions(
    session: AsyncSession, branch_id: uuid.UUID
) -> dict[tuple[str, str, str], PlanBranchMergeResolution]:
    rows = (
        (
            await session.execute(
                select(PlanBranchMergeResolution).where(
                    PlanBranchMergeResolution.branch_id == branch_id
                )
            )
        )
        .scalars()
        .all()
    )
    return {(r.entity_type, r.entity_name, r.field_name): r for r in rows}


async def get_branch_conflicts(
    session: AsyncSession, slug: str, branch_id: uuid.UUID
) -> BranchConflictsResponse:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    _reject_main(branch)

    main_branch_id = await ensure_main_branch_id(session, project.id)
    base_payload: dict = {}
    if branch.base_revision_id is not None:
        base_rev = await session.get(PlanRevision, branch.base_revision_id)
        if base_rev is not None:
            base_payload = base_rev.payload or {}
    main_payload = await build_plan_snapshot(session, project.id, branch_id=main_branch_id)
    branch_payload = await build_plan_snapshot(session, project.id, branch_id=branch.id)

    raw = _field_conflicts_event_type(base_payload, main_payload, branch_payload)
    resolutions = await _load_resolutions(session, branch.id)

    by_entity: dict[str, list[ConflictField]] = {}
    unresolved = 0
    for row in raw:
        choice = None
        key = (row["entity_type"], row["name"], row["field"])
        if key in resolutions:
            choice = resolutions[key].choice
        else:
            unresolved += 1
        by_entity.setdefault(row["name"], []).append(
            ConflictField(
                field=row["field"],
                base=row["base"],
                ours=row["ours"],
                theirs=row["theirs"],
                choice=choice,
            )
        )

    entities = [
        ConflictEntity(entity_type="event_type", name=name, fields=fields)
        for name, fields in sorted(by_entity.items())
    ]
    return BranchConflictsResponse(entities=entities, unresolved_count=unresolved)


async def save_resolution(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID,
    data: ResolutionCreate,
    user_id: uuid.UUID | None,
) -> ResolutionResponse:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    _reject_main(branch)

    existing = await session.scalar(
        select(PlanBranchMergeResolution).where(
            PlanBranchMergeResolution.branch_id == branch.id,
            PlanBranchMergeResolution.entity_type == data.entity_type,
            PlanBranchMergeResolution.entity_name == data.entity_name,
            PlanBranchMergeResolution.field_name == data.field_name,
        )
    )
    if existing is not None:
        existing.choice = data.choice
        existing.resolved_by = user_id
        resolution = existing
    else:
        resolution = PlanBranchMergeResolution(
            branch_id=branch.id,
            entity_type=data.entity_type,
            entity_name=data.entity_name,
            field_name=data.field_name,
            choice=data.choice,
            resolved_by=user_id,
        )
        session.add(resolution)
    await session.commit()
    await session.refresh(resolution)
    return ResolutionResponse.model_validate(resolution)


async def delete_resolution(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID,
    resolution_id: uuid.UUID,
) -> None:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    _reject_main(branch)
    resolution = await session.get(PlanBranchMergeResolution, resolution_id)
    if resolution is None or resolution.branch_id != branch.id:
        raise HTTPException(status_code=404, detail="Resolution not found")
    await session.delete(resolution)
    await session.commit()
