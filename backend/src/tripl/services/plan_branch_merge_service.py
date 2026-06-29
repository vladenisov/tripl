from __future__ import annotations

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
from tripl.models.variable import Variable
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
from tripl.services.plan_revision_service import build_plan_snapshot


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
    Children (field_definitions, event_field_values, event_meta_values,
    event_tags) are replaced wholesale with FK-remapped copies.

    ``resolutions`` maps (entity_type, name, field) -> "ours" | "theirs" and
    is honored for event_type metadata fields: "ours" keeps main's current
    value for that field instead of taking the branch's. Defaults to "theirs"
    (branch wins) when no resolution is supplied.
    """
    resolutions = resolutions or {}
    base_et_by_name: dict[str, dict[str, Any]] = {
        e["name"]: e for e in (base_payload or {}).get("event_types", [])
    }
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
        if name not in branch_et_by_name:
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

    # --- field_definitions: wholesale replace per main event_type, build name→id map
    main_field_by_key: dict[tuple[str, str], uuid.UUID] = {}
    for et_name, m_et_id in main_et_name_to_id.items():
        b_et = branch_et_by_name[et_name]
        await session.execute(
            delete(FieldDefinition).where(FieldDefinition.event_type_id == m_et_id)
        )
        await session.flush()
        for b_fd in b_et.field_definitions:
            fid = uuid.uuid4()
            session.add(
                FieldDefinition(
                    id=fid,
                    event_type_id=m_et_id,
                    name=b_fd.name,
                    display_name=b_fd.display_name,
                    field_type=b_fd.field_type,
                    is_required=b_fd.is_required,
                    enum_options=list(b_fd.enum_options) if b_fd.enum_options else None,
                    description=b_fd.description,
                    order=b_fd.order,
                    sensitivity=b_fd.sensitivity,
                    contract_required_max_null_rate=b_fd.contract_required_max_null_rate,
                    contract_regex=b_fd.contract_regex,
                    contract_min_value=b_fd.contract_min_value,
                    contract_max_value=b_fd.contract_max_value,
                    contract_max_bad_rate=b_fd.contract_max_bad_rate or 0.0,
                )
            )
            main_field_by_key[(et_name, b_fd.name)] = fid
    await session.flush()

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
    for name, b_mf in branch_mf_by_name.items():
        m_mf = main_mf_by_name.get(name)
        if m_mf is not None:
            m_mf.display_name = b_mf.display_name
            m_mf.field_type = b_mf.field_type
            m_mf.is_required = b_mf.is_required
            m_mf.enum_options = list(b_mf.enum_options) if b_mf.enum_options else None
            m_mf.default_value = b_mf.default_value
            m_mf.link_template = b_mf.link_template
            m_mf.order = b_mf.order
            m_mf.sensitivity = b_mf.sensitivity
        else:
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
        if name not in branch_mf_by_name:
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
    for name, b_v in branch_var_by_name.items():
        m_v = main_var_by_name.get(name)
        if m_v is not None:
            m_v.source_name = b_v.source_name
            m_v.variable_type = b_v.variable_type
            m_v.description = b_v.description
        else:
            session.add(
                Variable(
                    id=uuid.uuid4(),
                    project_id=project_id,
                    branch_id=main_branch_id,
                    name=b_v.name,
                    source_name=b_v.source_name,
                    variable_type=b_v.variable_type,
                    description=b_v.description,
                )
            )
    for name, m_v in list(main_var_by_name.items()):
        if name not in branch_var_by_name:
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

    for key, b_ev in branch_event_by_key.items():
        et_name, _ev_name = key
        if key in main_event_by_key:
            m_ev = main_event_by_key[key]
            m_ev.source_name = b_ev.source_name
            m_ev.description = b_ev.description
            b_status = _ES(b_ev.status)
            m_status = _ES(m_ev.status)
            if b_status == _ES.archived:
                m_ev.status = m_status
            else:
                m_ev.status = b_status if _rank(b_status) >= _rank(m_status) else m_status
            m_ev.sunset_at = b_ev.sunset_at
            m_ev.order = b_ev.order
            m_ev.metric_breakdown_columns = list(b_ev.metric_breakdown_columns or [])
            # Rebuild children
            await session.execute(
                delete(EventFieldValue).where(EventFieldValue.event_id == m_ev.id)
            )
            await session.execute(delete(EventMetaValue).where(EventMetaValue.event_id == m_ev.id))
            await session.execute(delete(EventTag).where(EventTag.event_id == m_ev.id))
            await session.flush()
            for fv in b_ev.field_values:
                bf_et, bf_name = branch_field_by_id[fv.field_definition_id]
                session.add(
                    EventFieldValue(
                        id=uuid.uuid4(),
                        event_id=m_ev.id,
                        field_definition_id=main_field_by_key[(bf_et, bf_name)],
                        value=fv.value,
                    )
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
            for tag in b_ev.tags:
                session.add(EventTag(id=uuid.uuid4(), event_id=m_ev.id, name=tag.name))
        else:
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
        if key not in branch_event_by_key:
            await session.delete(m_ev)
    await session.flush()

    # --- photos + comments: wholesale replace per surviving event on main.
    # The branch is the source of truth for the design canvas, so main photos
    # under matched/new events are dropped and re-copied from the branch with
    # remapped event_id. storage_key/external_url is reused — no blob copies.
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

    # --- relations: wholesale replace on main using name-based FK remap
    branch_relations = await _load_for_branch(session, EventTypeRelation, project_id, branch_id)
    await session.execute(
        delete(EventTypeRelation).where(
            EventTypeRelation.project_id == project_id,
            EventTypeRelation.branch_id == main_branch_id,
        )
    )
    await session.flush()
    # Resolve names from the branch side: relations on the branch reference its
    # own ETs/fields; translate to the matching main ids by name.
    branch_fd_id_to_key = {
        fd.id: (branch_et_id_to_name[fd.event_type_id], fd.name)
        for et in branch_ets
        for fd in et.field_definitions
    }
    for b_rel in branch_relations:
        src_et_name = branch_et_id_to_name[b_rel.source_event_type_id]
        tgt_et_name = branch_et_id_to_name[b_rel.target_event_type_id]
        src_fd_key = branch_fd_id_to_key[b_rel.source_field_id]
        tgt_fd_key = branch_fd_id_to_key[b_rel.target_field_id]
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
) -> None:
    """Block the merge when an owned event type is touched without an owner's
    approval. Owners attach to live main rows only, so unowned event types
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

    approvals = await session.execute(
        select(PlanBranchApproval.user_id).where(PlanBranchApproval.branch_id == branch_id)
    )
    approver_ids = {row[0] for row in approvals.all()}

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

    await _check_owner_approvals(
        session,
        project_id=project.id,
        main_branch_id=main_branch_id,
        branch_id=branch.id,
        base_payload=base_payload,
        branch_payload=branch_payload,
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
    return await _to_detail(session, branch)
