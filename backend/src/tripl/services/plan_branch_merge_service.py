from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.models.event import Event
from tripl.models.event import EventStatus as _ES
from tripl.models.event import event_status_rank as _rank
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_meta_value import EventMetaValue
from tripl.models.event_photo import EventPhoto
from tripl.models.event_photo_comment import EventPhotoComment
from tripl.models.event_tag import EventTag
from tripl.models.event_type import EventType
from tripl.models.event_type_owner import EventTypeOwner
from tripl.models.event_type_relation import EventTypeRelation
from tripl.models.field_definition import FieldDefinition
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.models.plan_branch import BranchStatus, PlanBranch
from tripl.models.plan_branch_approval import PlanBranchApproval
from tripl.models.plan_branch_reviewer import PlanBranchReviewer
from tripl.models.plan_revision import PlanRevision
from tripl.models.project_tracker_config import ProjectTrackerConfig
from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.schemas.plan_branch import PlanBranchDetailResponse
from tripl.services.event_type_owner_service import load_owner_user_ids
from tripl.services.plan_branch_conflicts import (
    _ET_CHANGE_KEYS,
    _detect_merge_conflicts,
    _entity_changed,
    _field_conflicts_event_type,
    _load_resolutions,
)
from tripl.services.plan_branch_service import (
    _get_branch,
    _load_for_branch,
    _reject_main,
    _resolve_project,
    _to_detail,
    ensure_main_branch_id,
)
from tripl.services.plan_revision_service import (
    PLAN_SNAPSHOT_VERSION,
    build_plan_snapshot,
    plan_snapshot_hash,
)
from tripl.services.project_branch_settings_service import read_branch_merge_policy

logger = logging.getLogger(__name__)


async def _load_fresh_approver_ids(
    session: AsyncSession,
    *,
    branch_id: uuid.UUID,
    current_plan_hash: str,
) -> tuple[set[uuid.UUID], int]:
    """Distinct users whose approval matches the branch's CURRENT content.

    An approval stamped for earlier content (or a legacy NULL-hash row) is
    stale — the branch changed after the review, so it must not satisfy any
    merge gate (tripl-d8v6). Returns ``(fresh_ids, stale_count)``; approvals
    whose user was deleted (NULL user_id) never count.
    """
    approvals = await session.execute(
        select(PlanBranchApproval.user_id, PlanBranchApproval.plan_hash).where(
            PlanBranchApproval.branch_id == branch_id
        )
    )
    fresh: set[uuid.UUID] = set()
    stale = 0
    for user_id, plan_hash in approvals.all():
        if user_id is None:
            continue
        if plan_hash == current_plan_hash:
            fresh.add(user_id)
        else:
            stale += 1
    return fresh, stale


async def _check_min_approvals(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch: PlanBranch,
    current_plan_hash: str,
) -> None:
    """Block the merge until the project's approval quota is met.

    Counts distinct users with a FRESH approval (content hash matches the
    branch's current plan). The author's own approval is discarded when the
    policy blocks self-approval (defense in depth — the approve transition
    already rejects it, but rows created before the policy flipped on must
    not satisfy the gate either).
    """
    policy = await read_branch_merge_policy(session, project_id)
    if policy.min_approvals <= 0:
        return

    approver_ids, stale_count = await _load_fresh_approver_ids(
        session, branch_id=branch.id, current_plan_hash=current_plan_hash
    )
    if policy.block_self_approval and branch.created_by is not None:
        approver_ids.discard(branch.created_by)

    if len(approver_ids) < policy.min_approvals:
        raise HTTPException(
            status_code=409,
            detail={
                "insufficient_approvals": {
                    "required": policy.min_approvals,
                    "current": len(approver_ids),
                    "stale": stale_count,
                }
            },
        )


async def _apply_merge(
    session: AsyncSession,
    project_id: uuid.UUID,
    main_branch_id: uuid.UUID,
    branch_id: uuid.UUID,
    *,
    resolutions: dict[tuple[str, str, str], str] | None = None,
    base_payload: dict[str, Any] | None = None,
) -> None:
    """Apply the branch's plan onto main with upsert-by-natural-key.

    Matched event_type/event rows are updated in place (id preserved) so
    runtime rows linked by id (metrics, photos, alerts) survive the merge.
    Each entity and child collection is applied only when the branch changed it
    from the recorded base. This preserves one-sided main edits and deletions;
    conflict detection rejects divergent edits before this function runs.

    ``resolutions`` maps (entity_type, name, field) -> "ours" | "theirs" and
    is honored for event_type metadata fields: "ours" keeps main's current
    value for that field instead of taking the branch's. Defaults to "theirs"
    (branch wins) when no resolution is supplied.
    """
    resolutions = resolutions or {}
    base_et_by_name: dict[str, dict[str, Any]] = {
        e["name"]: e for e in (base_payload or {}).get("event_types", [])
    }
    branch_snapshot_payload = await build_plan_snapshot(
        session, project_id, branch_id=branch_id
    )
    # --- event_types
    main_ets = list(
        (
            await session.execute(
                select(EventType)
                .where(EventType.project_id == project_id, EventType.branch_id == main_branch_id)
                .options(selectinload(EventType.field_definitions))
            )
        )
        .scalars()
        .all()
    )
    branch_ets = list(
        (
            await session.execute(
                select(EventType)
                .where(EventType.project_id == project_id, EventType.branch_id == branch_id)
                .options(selectinload(EventType.field_definitions))
            )
        )
        .scalars()
        .all()
    )
    main_et_by_name = {et.name: et for et in main_ets}
    branch_et_by_name = {et.name: et for et in branch_ets}

    for name, b_et in branch_et_by_name.items():
        m_et = main_et_by_name.get(name)
        if m_et is not None:
            # 3-way per-field merge. Falls back to branch-wins when no base
            # snapshot is available (legacy path).
            b_dict = base_et_by_name.get(name)
            for field in _ET_CHANGE_KEYS:
                choice = resolutions.get(("event_type", name, field))
                if choice == "ours":
                    continue
                if choice == "theirs":
                    setattr(m_et, field, getattr(b_et, field))
                    continue
                if b_dict is None:
                    setattr(m_et, field, getattr(b_et, field))
                    continue
                base_v = b_dict.get(field)
                theirs_v = getattr(b_et, field)
                # Branch changed this field → take it; otherwise keep main's
                # current value (which may include main-side edits).
                if theirs_v != base_v:
                    setattr(m_et, field, theirs_v)
        else:
            # The entity existed in the base but is now absent on main: that is
            # a main-only deletion. An unchanged branch must not resurrect it.
            # Divergent branch edits are rejected by conflict detection.
            if name in base_et_by_name:
                continue
            session.add(
                EventType(
                    id=uuid.uuid4(),
                    project_id=project_id,
                    branch_id=main_branch_id,
                    name=b_et.name,
                    display_name=b_et.display_name,
                    description=b_et.description,
                    color=b_et.color,
                    order=b_et.order,
                )
            )
    for name, m_et in list(main_et_by_name.items()):
        if name in base_et_by_name and name not in branch_et_by_name:
            await session.delete(m_et)
            del main_et_by_name[name]
    await session.flush()

    # Re-load main event types so name→id mapping reflects new inserts.
    main_ets_after = list(
        (
            await session.execute(
                select(EventType).where(
                    EventType.project_id == project_id, EventType.branch_id == main_branch_id
                )
            )
        )
        .scalars()
        .all()
    )
    main_et_name_to_id = {et.name: et.id for et in main_ets_after}
    branch_et_id_to_name = {et.id: et.name for et in branch_ets}

    # --- field_definitions: apply only branch-side deltas from the base.
    # Main-only additions/edits therefore survive an unrelated branch merge.
    main_field_by_key: dict[tuple[str, str], uuid.UUID] = {}
    field_attrs = (
        "display_name",
        "field_type",
        "is_required",
        "enum_options",
        "description",
        "order",
        "sensitivity",
        "contract_required_max_null_rate",
        "contract_regex",
        "contract_min_value",
        "contract_max_value",
        "contract_max_bad_rate",
    )
    main_et_by_id = {event_type.id: event_type for event_type in main_ets_after}
    main_fields = list(
        (
            await session.execute(
                select(FieldDefinition).where(
                    FieldDefinition.event_type_id.in_(list(main_et_by_id))
                )
            )
        )
        .scalars()
        .all()
    )
    main_fields_by_key = {
        (main_et_by_id[field.event_type_id].name, field.name): field for field in main_fields
    }
    for et_name, b_et in branch_et_by_name.items():
        if et_name not in main_et_name_to_id:
            continue
        m_et_id = main_et_name_to_id[et_name]
        base_fields = {
            field["name"]: field
            for field in base_et_by_name.get(et_name, {}).get("field_definitions", [])
        }
        branch_fields = {field.name: field for field in b_et.field_definitions}
        for field_name, b_fd in branch_fields.items():
            key = (et_name, field_name)
            m_fd = main_fields_by_key.get(key)
            base_fd = base_fields.get(field_name)
            if m_fd is None:
                if base_fd is not None:
                    continue
                m_fd = FieldDefinition(
                    id=uuid.uuid4(), event_type_id=m_et_id, name=field_name
                )
                session.add(m_fd)
                main_fields_by_key[key] = m_fd
            for attr in field_attrs:
                branch_value = getattr(b_fd, attr)
                if base_fd is None or branch_value != base_fd.get(attr):
                    if attr == "enum_options":
                        branch_value = list(branch_value) if branch_value else None
                    setattr(m_fd, attr, branch_value)
        for field_name in set(base_fields) - set(branch_fields):
            m_fd = main_fields_by_key.pop((et_name, field_name), None)
            if m_fd is not None:
                await session.delete(m_fd)
    await session.flush()

    main_field_by_key = {key: field.id for key, field in main_fields_by_key.items()}

    branch_field_by_id = {
        fd.id: (branch_et_id_to_name[fd.event_type_id], fd.name)
        for et in branch_ets
        for fd in et.field_definitions
    }

    # --- meta_field_definitions: upsert by name (preserve ids)
    main_mfs = await _load_for_branch(session, MetaFieldDefinition, project_id, main_branch_id)
    branch_mfs = await _load_for_branch(session, MetaFieldDefinition, project_id, branch_id)
    main_mf_by_name = {mf.name: mf for mf in main_mfs}
    branch_mf_by_name = {mf.name: mf for mf in branch_mfs}
    base_mf_by_name = {mf["name"]: mf for mf in (base_payload or {}).get("meta_fields", [])}
    meta_attrs = (
        "display_name",
        "field_type",
        "is_required",
        "enum_options",
        "default_value",
        "link_template",
        "order",
        "sensitivity",
    )
    for name, b_mf in branch_mf_by_name.items():
        m_mf = main_mf_by_name.get(name)
        if m_mf is not None:
            base_mf = base_mf_by_name.get(name)
            for attr in meta_attrs:
                branch_value = getattr(b_mf, attr)
                if base_mf is None or branch_value != base_mf.get(attr):
                    if attr == "enum_options":
                        branch_value = list(branch_value) if branch_value else None
                    setattr(m_mf, attr, branch_value)
        else:
            if name in base_mf_by_name:
                continue
            session.add(
                MetaFieldDefinition(
                    id=uuid.uuid4(),
                    project_id=project_id,
                    branch_id=main_branch_id,
                    name=b_mf.name,
                    display_name=b_mf.display_name,
                    field_type=b_mf.field_type,
                    is_required=b_mf.is_required,
                    enum_options=list(b_mf.enum_options) if b_mf.enum_options else None,
                    default_value=b_mf.default_value,
                    link_template=b_mf.link_template,
                    order=b_mf.order,
                    sensitivity=b_mf.sensitivity,
                )
            )
    for name, m_mf in list(main_mf_by_name.items()):
        if name in base_mf_by_name and name not in branch_mf_by_name:
            await session.delete(m_mf)
    await session.flush()
    main_mf_name_to_id = {
        mf.name: mf.id
        for mf in await _load_for_branch(session, MetaFieldDefinition, project_id, main_branch_id)
    }
    branch_mf_id_to_name = {mf.id: mf.name for mf in branch_mfs}

    # --- variables: upsert by name
    main_vars = await _load_for_branch(session, Variable, project_id, main_branch_id)
    branch_vars = await _load_for_branch(session, Variable, project_id, branch_id)
    main_var_by_name = {v.name: v for v in main_vars}
    branch_var_by_name = {v.name: v for v in branch_vars}
    base_var_by_name = {v["name"]: v for v in (base_payload or {}).get("variables", [])}
    variable_attrs = (
        "source_name",
        "variable_type",
        "description",
        "allowed_values",
        "bindings",
        "excluded_from_scans",
    )
    for name, b_v in branch_var_by_name.items():
        m_v = main_var_by_name.get(name)
        if m_v is not None:
            base_var = base_var_by_name.get(name)
            for attr in variable_attrs:
                branch_value = getattr(b_v, attr)
                if base_var is None or branch_value != base_var.get(attr):
                    if attr in ("allowed_values", "bindings"):
                        branch_value = list(branch_value or [])
                    setattr(m_v, attr, branch_value)
        else:
            if name in base_var_by_name:
                continue
            session.add(
                Variable(
                    id=uuid.uuid4(),
                    project_id=project_id,
                    branch_id=main_branch_id,
                    name=b_v.name,
                    source_name=b_v.source_name,
                    variable_type=b_v.variable_type,
                    description=b_v.description,
                    allowed_values=list(b_v.allowed_values or []),
                    bindings=list(b_v.bindings or []),
                    excluded_from_scans=b_v.excluded_from_scans,
                )
            )
    for name, m_v in list(main_var_by_name.items()):
        if name in base_var_by_name and name not in branch_var_by_name:
            await session.delete(m_v)

    # --- events: upsert by (event_type_name, name); preserve ids + remap children
    main_events = list(
        (
            await session.execute(
                select(Event)
                .where(Event.project_id == project_id, Event.branch_id == main_branch_id)
                .options(
                    selectinload(Event.field_values),
                    selectinload(Event.meta_values),
                    selectinload(Event.tags),
                )
            )
        )
        .scalars()
        .all()
    )
    branch_events = list(
        (
            await session.execute(
                select(Event)
                .where(Event.project_id == project_id, Event.branch_id == branch_id)
                .options(
                    selectinload(Event.field_values),
                    selectinload(Event.meta_values),
                    selectinload(Event.tags),
                )
            )
        )
        .scalars()
        .all()
    )
    main_et_id_to_name = {et.id: et.name for et in main_ets_after}
    # Events whose parent event_type was just removed are orphans on main; in
    # Postgres they'd cascade-delete via the FK, SQLite (test env) doesn't, so
    # we delete them explicitly to keep the in-memory lookup consistent.
    for e in main_events:
        if e.event_type_id not in main_et_id_to_name:
            await session.delete(e)
    await session.flush()
    main_events = [e for e in main_events if e.event_type_id in main_et_id_to_name]
    main_event_by_key = {(main_et_id_to_name[e.event_type_id], e.name): e for e in main_events}
    branch_event_by_key = {
        (branch_et_id_to_name[e.event_type_id], e.name): e for e in branch_events
    }
    base_event_by_key = {
        (event["event_type_name"], event["name"]): event
        for event in (base_payload or {}).get("events", [])
    }
    branch_event_snapshot_by_key = {
        (event["event_type_name"], event["name"]): event
        for event in branch_snapshot_payload.get("events", [])
    }

    for key, b_ev in branch_event_by_key.items():
        et_name, _ev_name = key
        if key in main_event_by_key:
            m_ev = main_event_by_key[key]
            base_event = base_event_by_key.get(key)
            branch_event_snapshot = branch_event_snapshot_by_key[key]
            event_attrs = (
                "source_name",
                "description",
                "sunset_at",
                "order",
                "owner_id",
                "reviewed",
                "metric_breakdown_columns",
            )
            for attr in event_attrs:
                if base_event is None or branch_event_snapshot.get(attr) != base_event.get(attr):
                    branch_value = getattr(b_ev, attr)
                    if attr == "metric_breakdown_columns":
                        branch_value = list(branch_value or [])
                    setattr(m_ev, attr, branch_value)
            if base_event is None or branch_event_snapshot.get("status") != base_event.get(
                "status"
            ):
                b_status = _ES(b_ev.status)
                m_status = _ES(m_ev.status)
                if b_status != _ES.archived:
                    m_ev.status = b_status if _rank(b_status) >= _rank(m_status) else m_status

            if base_event is None or branch_event_snapshot.get("field_values") != base_event.get(
                "field_values"
            ):
                await session.execute(
                    delete(EventFieldValue).where(EventFieldValue.event_id == m_ev.id)
                )
                for fv in b_ev.field_values:
                    bf_et, bf_name = branch_field_by_id[fv.field_definition_id]
                    session.add(
                        EventFieldValue(
                            id=uuid.uuid4(),
                            event_id=m_ev.id,
                            field_definition_id=main_field_by_key[(bf_et, bf_name)],
                            value=fv.value,
                            is_authored=fv.is_authored,
                        )
                    )
            if base_event is None or branch_event_snapshot.get("meta_values") != base_event.get(
                "meta_values"
            ):
                await session.execute(
                    delete(EventMetaValue).where(EventMetaValue.event_id == m_ev.id)
                )
                for mv in b_ev.meta_values:
                    mf_name = branch_mf_id_to_name[mv.meta_field_definition_id]
                    session.add(
                        EventMetaValue(
                            id=uuid.uuid4(),
                            event_id=m_ev.id,
                            meta_field_definition_id=main_mf_name_to_id[mf_name],
                            value=mv.value,
                        )
                    )
            if base_event is None or branch_event_snapshot.get("tags") != base_event.get("tags"):
                await session.execute(delete(EventTag).where(EventTag.event_id == m_ev.id))
                for tag in b_ev.tags:
                    session.add(EventTag(id=uuid.uuid4(), event_id=m_ev.id, name=tag.name))
        else:
            if key in base_event_by_key or et_name not in main_et_name_to_id:
                continue
            new_ev_id = uuid.uuid4()
            session.add(
                Event(
                    id=new_ev_id,
                    project_id=project_id,
                    branch_id=main_branch_id,
                    event_type_id=main_et_name_to_id[et_name],
                    name=b_ev.name,
                    source_name=b_ev.source_name,
                    description=b_ev.description,
                    order=b_ev.order,
                    status=b_ev.status,
                    sunset_at=b_ev.sunset_at,
                    last_seen_at=b_ev.last_seen_at,
                    metric_breakdown_columns=list(b_ev.metric_breakdown_columns or []),
                    owner_id=b_ev.owner_id,
                    reviewed=b_ev.reviewed,
                )
            )
            for fv in b_ev.field_values:
                bf_et, bf_name = branch_field_by_id[fv.field_definition_id]
                session.add(
                    EventFieldValue(
                        id=uuid.uuid4(),
                        event_id=new_ev_id,
                        field_definition_id=main_field_by_key[(bf_et, bf_name)],
                        value=fv.value,
                        is_authored=fv.is_authored,
                    )
                )
            for mv in b_ev.meta_values:
                mf_name = branch_mf_id_to_name[mv.meta_field_definition_id]
                session.add(
                    EventMetaValue(
                        id=uuid.uuid4(),
                        event_id=new_ev_id,
                        meta_field_definition_id=main_mf_name_to_id[mf_name],
                        value=mv.value,
                    )
                )
            for tag in b_ev.tags:
                session.add(EventTag(id=uuid.uuid4(), event_id=new_ev_id, name=tag.name))
    for key, m_ev in list(main_event_by_key.items()):
        if key in base_event_by_key and key not in branch_event_by_key:
            await session.delete(m_ev)
    await session.flush()

    # --- photos + comments: replace only when the branch's design canvas
    # changed from the base. storage_key/external_url is reused — no blob copies.
    # Bulk delete via session.execute(delete(...)) is intentional: it bypasses
    # the ORM session.delete() path so storage backends aren't invoked here
    # (the blob is still referenced by the freshly-inserted main row).
    main_events_after = list(
        (
            await session.execute(
                select(Event).where(
                    Event.project_id == project_id, Event.branch_id == main_branch_id
                )
            )
        )
        .scalars()
        .all()
    )
    main_event_key_to_id: dict[tuple[str, str], uuid.UUID] = {}
    for e in main_events_after:
        main_et_name = main_et_id_to_name.get(e.event_type_id)
        if main_et_name is not None:
            main_event_key_to_id[(main_et_name, e.name)] = e.id

    for key, b_ev in branch_event_by_key.items():
        main_ev_id = main_event_key_to_id.get(key)
        if main_ev_id is None:
            continue
        base_event = base_event_by_key.get(key)
        branch_event_snapshot = branch_event_snapshot_by_key[key]
        if base_event is not None and branch_event_snapshot.get("photos") == base_event.get(
            "photos"
        ):
            continue
        await session.execute(delete(EventPhoto).where(EventPhoto.event_id == main_ev_id))
        await session.flush()

        branch_photos = list(
            (
                await session.execute(
                    select(EventPhoto)
                    .where(EventPhoto.event_id == b_ev.id)
                    .order_by(EventPhoto.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        photo_id_map: dict[uuid.UUID, uuid.UUID] = {}
        for bp in branch_photos:
            new_ph_id = uuid.uuid4()
            photo_id_map[bp.id] = new_ph_id
            session.add(
                EventPhoto(
                    id=new_ph_id,
                    project_id=project_id,
                    event_id=main_ev_id,
                    uploaded_by_user_id=bp.uploaded_by_user_id,
                    original_filename=bp.original_filename,
                    content_type=bp.content_type,
                    size_bytes=bp.size_bytes,
                    kind=bp.kind,
                    external_url=bp.external_url,
                    storage_backend=bp.storage_backend,
                    storage_key=bp.storage_key,
                    sort_order=bp.sort_order,
                )
            )
        await session.flush()
        if photo_id_map:
            branch_comments = list(
                (
                    await session.execute(
                        select(EventPhotoComment)
                        .where(EventPhotoComment.photo_id.in_(list(photo_id_map.keys())))
                        .order_by(EventPhotoComment.created_at.asc())
                    )
                )
                .scalars()
                .all()
            )
            comment_id_map: dict[uuid.UUID, uuid.UUID] = {}
            for bc in branch_comments:
                new_c_id = uuid.uuid4()
                comment_id_map[bc.id] = new_c_id
                session.add(
                    EventPhotoComment(
                        id=new_c_id,
                        photo_id=photo_id_map[bc.photo_id],
                        parent_id=(
                            comment_id_map.get(bc.parent_id) if bc.parent_id is not None else None
                        ),
                        user_id=bc.user_id,
                        body=bc.body,
                    )
                )
            await session.flush()

    # --- variable event value overrides: replace only for variables whose
    # branch-side override map changed from the base.
    main_vars_after = await _load_for_branch(session, Variable, project_id, main_branch_id)
    main_var_name_to_id = {v.name: v.id for v in main_vars_after}
    branch_event_id_to_key = {e.id: key for key, e in branch_event_by_key.items()}
    branch_overrides = await _load_for_branch(
        session, VariableEventValueOverride, project_id, branch_id
    )
    branch_overrides_by_var: dict[uuid.UUID, list[VariableEventValueOverride]] = {}
    for override in branch_overrides:
        branch_overrides_by_var.setdefault(override.variable_id, []).append(override)
    branch_var_snapshot_by_name = {
        variable["name"]: variable for variable in branch_snapshot_payload.get("variables", [])
    }
    for branch_var in branch_vars:
        name = branch_var.name
        base_var = base_var_by_name.get(name)
        branch_var_snapshot = branch_var_snapshot_by_name[name]
        if base_var is not None and branch_var_snapshot.get(
            "event_value_overrides"
        ) == base_var.get("event_value_overrides"):
            continue
        main_var_id = main_var_name_to_id.get(name)
        if main_var_id is None:
            continue
        await session.execute(
            delete(VariableEventValueOverride).where(
                VariableEventValueOverride.project_id == project_id,
                VariableEventValueOverride.branch_id == main_branch_id,
                VariableEventValueOverride.variable_id == main_var_id,
            )
        )
        for override in branch_overrides_by_var.get(branch_var.id, []):
            override_event_key = branch_event_id_to_key.get(override.event_id)
            main_override_event_id = (
                main_event_key_to_id.get(override_event_key)
                if override_event_key is not None
                else None
            )
            if main_override_event_id is None:
                continue
            session.add(
                VariableEventValueOverride(
                    id=uuid.uuid4(),
                    project_id=project_id,
                    branch_id=main_branch_id,
                    variable_id=main_var_id,
                    event_id=main_override_event_id,
                    values=list(override.values or []),
                )
            )
    await session.flush()

    # --- relations: natural-key three-way apply.
    branch_relations = await _load_for_branch(session, EventTypeRelation, project_id, branch_id)
    branch_fd_id_to_key = {
        fd.id: (branch_et_id_to_name[fd.event_type_id], fd.name)
        for et in branch_ets
        for fd in et.field_definitions
    }
    main_relations = await _load_for_branch(
        session, EventTypeRelation, project_id, main_branch_id
    )
    main_et_id_to_name_after = {et_id: name for name, et_id in main_et_name_to_id.items()}
    main_fd_id_to_key = {field_id: key for key, field_id in main_field_by_key.items()}

    def relation_key(
        relation: EventTypeRelation,
        et_names: dict[uuid.UUID, str],
        field_keys: dict[uuid.UUID, tuple[str, str]],
    ) -> tuple[str, str, str, str]:
        source_field = field_keys[relation.source_field_id]
        target_field = field_keys[relation.target_field_id]
        return (
            et_names[relation.source_event_type_id],
            source_field[1],
            et_names[relation.target_event_type_id],
            target_field[1],
        )

    main_relation_by_key = {
        relation_key(relation, main_et_id_to_name_after, main_fd_id_to_key): relation
        for relation in main_relations
        if relation.source_field_id in main_fd_id_to_key
        and relation.target_field_id in main_fd_id_to_key
    }
    branch_relation_by_key = {
        relation_key(relation, branch_et_id_to_name, branch_fd_id_to_key): relation
        for relation in branch_relations
    }
    base_relation_by_key = {
        (
            relation["source_event_type_name"],
            relation["source_field_name"],
            relation["target_event_type_name"],
            relation["target_field_name"],
        ): relation
        for relation in (base_payload or {}).get("relations", [])
    }
    for relation_key_value, b_rel in branch_relation_by_key.items():
        src_et_name, _src_field_name, tgt_et_name, _tgt_field_name = relation_key_value
        src_fd_key = branch_fd_id_to_key[b_rel.source_field_id]
        tgt_fd_key = branch_fd_id_to_key[b_rel.target_field_id]
        m_rel = main_relation_by_key.get(relation_key_value)
        if m_rel is None:
            if relation_key_value in base_relation_by_key:
                continue
            session.add(
                EventTypeRelation(
                    id=uuid.uuid4(),
                    project_id=project_id,
                    branch_id=main_branch_id,
                    source_event_type_id=main_et_name_to_id[src_et_name],
                    target_event_type_id=main_et_name_to_id[tgt_et_name],
                    source_field_id=main_field_by_key[src_fd_key],
                    target_field_id=main_field_by_key[tgt_fd_key],
                    relation_type=b_rel.relation_type,
                    description=b_rel.description,
                )
            )
            continue
        base_relation = base_relation_by_key.get(relation_key_value)
        if base_relation is None or b_rel.relation_type != base_relation.get("relation_type"):
            m_rel.relation_type = b_rel.relation_type
        if base_relation is None or b_rel.description != base_relation.get("description"):
            m_rel.description = b_rel.description
    for removed_relation_key in set(base_relation_by_key) - set(branch_relation_by_key):
        m_rel = main_relation_by_key.get(removed_relation_key)
        if m_rel is not None:
            await session.delete(m_rel)


def _touched_event_type_names(
    base_payload: dict[str, Any], branch_payload: dict[str, Any]
) -> set[str]:
    """Event-type names whose metadata differs between base and branch.

    Used to decide which event types' owners must approve the merge. Picks up
    additions, removals, and metadata changes (``_ET_CHANGE_KEYS``). Pure
    add/remove of children under an unchanged type does not count for v1 —
    owner gating triggers on type-level edits only.
    """
    base_by_name = {e["name"]: e for e in base_payload.get("event_types", [])}
    branch_by_name = {e["name"]: e for e in branch_payload.get("event_types", [])}
    touched: set[str] = set()
    for name in set(base_by_name) | set(branch_by_name):
        b = base_by_name.get(name)
        n = branch_by_name.get(name)
        if b is None or n is None or _entity_changed(b, n, _ET_CHANGE_KEYS):
            touched.add(name)
    return touched


async def _check_owner_approvals(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    main_branch_id: uuid.UUID,
    branch_id: uuid.UUID,
    base_payload: dict[str, Any],
    branch_payload: dict[str, Any],
    current_plan_hash: str,
) -> None:
    """Block the merge when an owned event type is touched without an owner's
    FRESH approval (stale approvals — content edited after review — don't
    count). Owners attach to live main rows only, so unowned event types
    (including freshly added ones that don't exist on main yet) auto-pass."""
    touched = _touched_event_type_names(base_payload, branch_payload)
    if not touched:
        return

    rows = await session.execute(
        select(EventType.id, EventType.name).where(
            EventType.project_id == project_id,
            EventType.branch_id == main_branch_id,
            EventType.name.in_(list(touched)),
        )
    )
    main_name_to_id = {name: et_id for et_id, name in rows.all()}
    if not main_name_to_id:
        return

    owners = await session.execute(
        select(EventTypeOwner.event_type_id, EventTypeOwner.user_id).where(
            EventTypeOwner.event_type_id.in_(list(main_name_to_id.values()))
        )
    )
    owners_by_et: dict[uuid.UUID, set[uuid.UUID]] = {}
    for et_id, user_id in owners.all():
        owners_by_et.setdefault(et_id, set()).add(user_id)
    if not owners_by_et:
        return

    approver_ids, _stale = await _load_fresh_approver_ids(
        session, branch_id=branch_id, current_plan_hash=current_plan_hash
    )

    missing: list[dict[str, Any]] = []
    for name, et_id in main_name_to_id.items():
        owners_set = owners_by_et.get(et_id)
        if not owners_set:
            continue
        if not (owners_set & approver_ids):
            missing.append(
                {
                    "event_type": name,
                    "owner_user_ids": [str(u) for u in sorted(owners_set, key=str)],
                }
            )
    if missing:
        raise HTTPException(
            status_code=409,
            detail={"missing_owner_approvals": missing},
        )


async def assign_owner_reviewers_for_branch(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch: PlanBranch,
) -> list[uuid.UUID]:
    """Upsert the owners of every touched event type as reviewers of ``branch``.

    Invoked when a branch enters review (the ``submit`` transition) so the people
    whose approval the merge gate later requires (:func:`_check_owner_approvals`)
    are surfaced as expected reviewers up front, without a manual lookup. The
    branch author is never assigned to review their own branch; whether an author
    may *approve* their own owned type is a separate policy (tripl-s8t0).

    Idempotent: the ``(branch_id, user_id)`` unique key plus the pre-read of
    existing reviewers means a re-submit adds nothing new. Does not commit — it
    joins the caller's transaction.
    """
    main_branch_id = await ensure_main_branch_id(session, project_id)

    base_payload: dict[str, Any] = {}
    if branch.base_revision_id is not None:
        base_rev = await session.get(PlanRevision, branch.base_revision_id)
        if base_rev is not None:
            base_payload = base_rev.payload or {}
    branch_payload = await build_plan_snapshot(session, project_id, branch_id=branch.id)

    touched = _touched_event_type_names(base_payload, branch_payload)
    if not touched:
        return []

    # Only live (main) rows can be owned — a type freshly added on the branch has
    # no owner yet, so it drops out here.
    rows = await session.execute(
        select(EventType.id).where(
            EventType.project_id == project_id,
            EventType.branch_id == main_branch_id,
            EventType.name.in_(list(touched)),
        )
    )
    main_et_ids = [et_id for (et_id,) in rows.all()]
    if not main_et_ids:
        return []

    owners_by_et = await load_owner_user_ids(session, main_et_ids)
    owner_ids: set[uuid.UUID] = set()
    for ids in owners_by_et.values():
        owner_ids |= ids
    if branch.created_by is not None:
        owner_ids.discard(branch.created_by)
    if not owner_ids:
        return []

    existing = await session.execute(
        select(PlanBranchReviewer.user_id).where(PlanBranchReviewer.branch_id == branch.id)
    )
    already = {user_id for (user_id,) in existing.all()}
    added: list[uuid.UUID] = []
    for user_id in sorted(owner_ids - already, key=str):
        session.add(PlanBranchReviewer(branch_id=branch.id, user_id=user_id))
        added.append(user_id)
    return added


def _touched_event_names(base_payload: dict[str, Any], branch_payload: dict[str, Any]) -> set[str]:
    """Event names added or changed on the branch relative to its merge base.

    ADDED = a name present on the branch but not the base. CHANGED = a name on
    both whose ``status``, ``description`` or ``event_type_name`` differs. These
    are exactly the events an implementation ticket should cover — a pure
    reorder (``order`` only) or unchanged carry-over is ignored."""
    base_by_name = {e["name"]: e for e in base_payload.get("events", [])}
    touched: set[str] = set()
    for name, branch_event in {e["name"]: e for e in branch_payload.get("events", [])}.items():
        base_event = base_by_name.get(name)
        if base_event is None:
            touched.add(name)
            continue
        if any(
            base_event.get(key) != branch_event.get(key)
            for key in ("status", "description", "event_type_name")
        ):
            touched.add(name)
    return touched


async def _enqueue_implementation_ticket(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    branch_name: str,
    base_payload: dict[str, Any],
    branch_payload: dict[str, Any],
    post_payload: dict[str, Any],
) -> None:
    """Best-effort: open one tracker ticket covering the branch's added/changed
    events when the project has an enabled tracker config.

    The merge is already committed by the time this runs, so any failure here —
    config lookup, name→id resolution, or the Celery enqueue — must be swallowed
    and logged rather than propagated. It must NEVER fail or roll back the merge.
    """
    try:
        touched = _touched_event_names(base_payload, branch_payload)
        if not touched:
            return
        # Resolve touched names to the post-merge MAIN event ids the ticket covers.
        post_id_by_name = {e["name"]: e["id"] for e in post_payload.get("events", [])}
        event_ids = [post_id_by_name[name] for name in sorted(touched) if name in post_id_by_name]
        if not event_ids:
            return
        config = await session.scalar(
            select(ProjectTrackerConfig).where(ProjectTrackerConfig.project_id == project_id)
        )
        if config is None or not config.enabled:
            return
        summary = f"Implement {len(event_ids)} event(s) from branch '{branch_name}'"
        # Lazy import: the worker task module pulls in Celery/worker deps that the
        # async request path shouldn't import at module load (cycle avoidance).
        from tripl.worker.tasks.implementation_tickets import create_implementation_ticket

        create_implementation_ticket.delay(str(project_id), str(branch_id), event_ids, summary)
    except Exception:  # noqa: BLE001 — tracker automation must never break a merge
        logger.exception("Failed to enqueue implementation ticket for branch %s", branch_id)


async def merge_branch(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID,
    user_id: uuid.UUID,
) -> PlanBranchDetailResponse:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    _reject_main(branch)
    if branch.status == BranchStatus.merged.value:
        raise HTTPException(status_code=400, detail="Branch is already merged")
    if branch.status != BranchStatus.approved.value:
        raise HTTPException(status_code=409, detail="Branch must be approved before merging")

    main_branch_id = await ensure_main_branch_id(session, project.id)
    base_payload: dict[str, Any] = {}
    if branch.base_revision_id is not None:
        base_rev = await session.get(PlanRevision, branch.base_revision_id)
        if base_rev is not None:
            base_payload = base_rev.payload or {}
    if base_payload.get("snapshot_version") != PLAN_SNAPSHOT_VERSION:
        raise HTTPException(
            status_code=409,
            detail={
                "incomplete_base_snapshot": True,
                "message": (
                    "This branch predates the complete merge baseline. "
                    "Recreate it from current main before merging."
                ),
            },
        )
    main_payload = await build_plan_snapshot(session, project.id, branch_id=main_branch_id)
    branch_payload = await build_plan_snapshot(session, project.id, branch_id=branch.id)

    all_conflicts = _detect_merge_conflicts(base_payload, main_payload, branch_payload)
    field_conflicts = _field_conflicts_event_type(base_payload, main_payload, branch_payload)
    # Modify-modify clashes on event_type fields are surfaced via the inline
    # resolution flow; entity-level adds/removes and conflicts on other entity
    # kinds stay hard blockers — they aren't covered by v1 resolutions.
    resolvable = {(c["entity_type"], c["name"]) for c in field_conflicts}
    blocking = [c for c in all_conflicts if (c["entity_type"], c["name"]) not in resolvable]
    if blocking:
        raise HTTPException(status_code=409, detail={"conflicts": blocking})

    resolution_map: dict[tuple[str, str, str], str] = {}
    if field_conflicts:
        resolutions = await _load_resolutions(session, branch.id)
        unresolved: list[dict[str, Any]] = []
        for fc in field_conflicts:
            key = (fc["entity_type"], fc["name"], fc["field"])
            res = resolutions.get(key)
            if res is None:
                unresolved.append(
                    {
                        "entity_type": fc["entity_type"],
                        "name": fc["name"],
                        "field": fc["field"],
                    }
                )
            else:
                resolution_map[key] = res.choice
        if unresolved:
            raise HTTPException(
                status_code=409,
                detail={"unresolved_field_conflicts": unresolved},
            )

    current_plan_hash = plan_snapshot_hash(branch_payload)
    await _check_min_approvals(
        session, project_id=project.id, branch=branch, current_plan_hash=current_plan_hash
    )

    await _check_owner_approvals(
        session,
        project_id=project.id,
        main_branch_id=main_branch_id,
        branch_id=branch.id,
        base_payload=base_payload,
        branch_payload=branch_payload,
        current_plan_hash=current_plan_hash,
    )

    await _apply_merge(
        session,
        project.id,
        main_branch_id,
        branch.id,
        resolutions=resolution_map,
        base_payload=base_payload,
    )

    # Post-merge snapshot of the live plan.
    post_payload = await build_plan_snapshot(session, project.id, branch_id=main_branch_id)
    session.add(
        PlanRevision(
            project_id=project.id,
            created_by=user_id,
            summary=f"Merged branch '{branch.name}'",
            payload=post_payload,
        )
    )

    branch.status = BranchStatus.merged.value
    branch.merged_at = datetime.now(UTC)
    branch.merged_by = user_id

    await session.commit()
    await session.refresh(branch)

    # Post-merge tracker automation (best-effort; the merge is already committed).
    await _enqueue_implementation_ticket(
        session,
        project_id=project.id,
        branch_id=branch.id,
        branch_name=branch.name,
        base_payload=base_payload,
        branch_payload=branch_payload,
        post_payload=post_payload,
    )

    # Refresh main's search index right away — the merge just rewrote main's
    # entities, and the next worker-side refresh (post-scan) or CRUD edit may be
    # far off. Best-effort: the merge is committed, so a search-index failure
    # must never fail the merge response. Lazy import mirrors the ticket task
    # above (avoids service-module import cycles).
    try:
        from tripl.services.search_service import reindex_project_branch

        await reindex_project_branch(
            session, project_id=project.id, branch_id=main_branch_id, slug=slug
        )
    except Exception:  # noqa: BLE001 — search staleness must never break a merge
        logger.exception("Failed to reindex search after merging branch %s", branch.id)
    return await _to_detail(session, branch)
