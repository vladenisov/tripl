"""Plan branch lifecycle: main-branch resolution, branch CRUD, deep-copy.

A project's tracking plan lives on its single ``kind="main"`` PlanBranch. Creating
a working branch deep-copies every design-time entity from main into the new branch
(fresh ids, FK remap) so edits are isolated. ``main`` is a real row (never NULL) so
the ``(project_id, branch_id, name)`` unique constraints are enforced on the live plan.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.models.event import Event
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
from tripl.models.plan_branch import BranchKind, BranchStatus, PlanBranch
from tripl.models.plan_branch_approval import PlanBranchApproval
from tripl.models.plan_branch_comment import PlanBranchComment
from tripl.models.plan_branch_merge_resolution import PlanBranchMergeResolution
from tripl.models.plan_branch_reviewer import PlanBranchReviewer
from tripl.models.plan_revision import PlanRevision
from tripl.models.project import Project
from tripl.models.user import User
from tripl.models.variable import Variable
from tripl.schemas.plan_branch import (
    BranchCommentCreate,
    BranchCommentResponse,
    BranchConflictsResponse,
    BranchReviewerCreate,
    BranchReviewerResponse,
    BranchTransitionAction,
    ConflictEntity,
    ConflictField,
    PlanBranchCreate,
    PlanBranchDetailResponse,
    PlanBranchDiff,
    PlanBranchList,
    PlanBranchResponse,
    ResolutionCreate,
    ResolutionResponse,
)
from tripl.services.plan_revision_service import build_plan_snapshot, compute_plan_diff_entries

MAIN_BRANCH_NAME = "main"

# action -> (allowed source states, target state)
_TRANSITIONS: dict[str, tuple[set[str], str]] = {
    "submit": (
        {BranchStatus.draft.value, BranchStatus.changes_requested.value},
        BranchStatus.ready_for_review.value,
    ),
    "request_changes": (
        {BranchStatus.ready_for_review.value, BranchStatus.approved.value},
        BranchStatus.changes_requested.value,
    ),
    "approve": ({BranchStatus.ready_for_review.value}, BranchStatus.approved.value),
    "reopen": (
        {
            BranchStatus.approved.value,
            BranchStatus.changes_requested.value,
            BranchStatus.closed.value,
        },
        BranchStatus.draft.value,
    ),
    "close": (
        {
            BranchStatus.draft.value,
            BranchStatus.ready_for_review.value,
            BranchStatus.changes_requested.value,
            BranchStatus.approved.value,
        },
        BranchStatus.closed.value,
    ),
}
# Transitions that invalidate prior approvals (fresh review needed).
_APPROVAL_CLEARING_ACTIONS = {"submit", "request_changes", "reopen"}


async def ensure_main_branch_id(session: AsyncSession, project_id: uuid.UUID) -> uuid.UUID:
    """Return the project's main branch id, creating it on first use.

    Resolved lazily (rather than only at project creation) so every code path —
    including projects seeded directly via the ORM in tests — gets a valid
    ``branch_id`` for the live plan. Flushes (not commits) so it joins the
    caller's transaction.
    """
    existing = await session.scalar(
        select(PlanBranch.id).where(
            PlanBranch.project_id == project_id,
            PlanBranch.kind == BranchKind.main.value,
        )
    )
    if existing is not None:
        return existing
    branch = PlanBranch(
        project_id=project_id,
        name=MAIN_BRANCH_NAME,
        kind=BranchKind.main.value,
        status=BranchStatus.merged.value,
    )
    session.add(branch)
    await session.flush()
    return branch.id


async def resolve_branch_id(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id_override: uuid.UUID | None = None,
) -> uuid.UUID:
    """Resolve which branch a service call should act on.

    Service code passes the editor's optional override through (``None`` =
    operate on main). Defence in depth: even though the API dep already
    validates the override against the slug, the service re-checks ownership so
    non-HTTP callers (workers, tests) can't slip into the wrong project.
    """
    if branch_id_override is None:
        return await ensure_main_branch_id(session, project_id)
    branch = await session.get(PlanBranch, branch_id_override)
    if branch is None or branch.project_id != project_id:
        raise HTTPException(status_code=404, detail="Branch not found")
    return branch.id


async def _resolve_project(session: AsyncSession, slug: str) -> Project:
    project = await session.scalar(select(Project).where(Project.slug == slug))
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _load_for_branch(
    session: AsyncSession,
    model: type,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> list:
    """SELECT all rows of ``model`` for ``(project_id, branch_id)`` as a list.

    Compact form of the ``select(...).where(project_id, branch_id)`` pattern
    used throughout deep-copy and merge. Joined-loaded selects (those that
    need ``selectinload``) stay inline because they want options on the
    statement that vary per call.
    """
    rows = await session.execute(
        select(model).where(model.project_id == project_id, model.branch_id == branch_id)
    )
    return list(rows.scalars().all())


def _to_response(branch: PlanBranch) -> PlanBranchResponse:
    return PlanBranchResponse.model_validate(branch)


async def list_branches(session: AsyncSession, slug: str) -> PlanBranchList:
    project = await _resolve_project(session, slug)
    await ensure_main_branch_id(session, project.id)
    await session.commit()
    rows = (
        (
            await session.execute(
                select(PlanBranch)
                .where(PlanBranch.project_id == project.id)
                # main first, then most-recent working branches.
                .order_by(PlanBranch.kind.desc(), PlanBranch.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    total = (
        await session.execute(
            select(func.count(PlanBranch.id)).where(PlanBranch.project_id == project.id)
        )
    ).scalar_one()
    return PlanBranchList(items=[_to_response(b) for b in rows], total=total)


async def _get_branch(
    session: AsyncSession, project_id: uuid.UUID, branch_id: uuid.UUID
) -> PlanBranch:
    branch = await session.get(PlanBranch, branch_id)
    if branch is None or branch.project_id != project_id:
        raise HTTPException(status_code=404, detail="Branch not found")
    return branch


async def _load_reviewers(
    session: AsyncSession, branch_id: uuid.UUID
) -> list[PlanBranchReviewer]:
    return list(
        (
            await session.execute(
                select(PlanBranchReviewer)
                .where(PlanBranchReviewer.branch_id == branch_id)
                .order_by(PlanBranchReviewer.created_at)
            )
        )
        .scalars()
        .all()
    )


async def _load_approvals(
    session: AsyncSession, branch_id: uuid.UUID
) -> list[PlanBranchApproval]:
    return list(
        (
            await session.execute(
                select(PlanBranchApproval)
                .where(PlanBranchApproval.branch_id == branch_id)
                .order_by(PlanBranchApproval.approved_at)
            )
        )
        .scalars()
        .all()
    )


async def _to_detail(
    session: AsyncSession, branch: PlanBranch
) -> PlanBranchDetailResponse:
    reviewers = await _load_reviewers(session, branch.id)
    approvals = await _load_approvals(session, branch.id)
    base = _to_response(branch)
    return PlanBranchDetailResponse(
        **base.model_dump(),
        reviewers=[BranchReviewerResponse.model_validate(r) for r in reviewers],
        approvals=[
            {"user_id": a.user_id, "approved_at": a.approved_at} for a in approvals
        ],  # type: ignore[list-item]
    )


async def get_branch(
    session: AsyncSession, slug: str, branch_id: uuid.UUID
) -> PlanBranchDetailResponse:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    return await _to_detail(session, branch)


async def _deep_copy_plan(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    source_branch_id: uuid.UUID,
    target_branch_id: uuid.UUID,
) -> None:
    """Copy every design-time entity from source branch into target branch.

    New ids are minted up front so FK remaps need no intermediate flush.
    Child tables (field_definitions, event_field_values, event_meta_values,
    event_tags) inherit their branch from the parent and carry no branch_id.
    """
    event_types = (
        (
            await session.execute(
                select(EventType)
                .where(
                    EventType.project_id == project_id,
                    EventType.branch_id == source_branch_id,
                )
                .options(selectinload(EventType.field_definitions))
            )
        )
        .scalars()
        .all()
    )
    et_map: dict[uuid.UUID, uuid.UUID] = {}
    fd_map: dict[uuid.UUID, uuid.UUID] = {}
    new_objs: list[object] = []
    for et in event_types:
        new_et_id = uuid.uuid4()
        et_map[et.id] = new_et_id
        new_objs.append(
            EventType(
                id=new_et_id,
                project_id=project_id,
                branch_id=target_branch_id,
                name=et.name,
                display_name=et.display_name,
                description=et.description,
                color=et.color,
                order=et.order,
            )
        )
        for fd in et.field_definitions:
            new_fd_id = uuid.uuid4()
            fd_map[fd.id] = new_fd_id
            new_objs.append(
                FieldDefinition(
                    id=new_fd_id,
                    event_type_id=new_et_id,
                    name=fd.name,
                    display_name=fd.display_name,
                    field_type=fd.field_type,
                    is_required=fd.is_required,
                    enum_options=list(fd.enum_options) if fd.enum_options else None,
                    description=fd.description,
                    order=fd.order,
                    sensitivity=fd.sensitivity,
                )
            )

    meta_fields = await _load_for_branch(
        session, MetaFieldDefinition, project_id, source_branch_id
    )
    mf_map: dict[uuid.UUID, uuid.UUID] = {}
    for mf in meta_fields:
        new_mf_id = uuid.uuid4()
        mf_map[mf.id] = new_mf_id
        new_objs.append(
            MetaFieldDefinition(
                id=new_mf_id,
                project_id=project_id,
                branch_id=target_branch_id,
                name=mf.name,
                display_name=mf.display_name,
                field_type=mf.field_type,
                is_required=mf.is_required,
                enum_options=list(mf.enum_options) if mf.enum_options else None,
                default_value=mf.default_value,
                link_template=mf.link_template,
                order=mf.order,
                sensitivity=mf.sensitivity,
            )
        )

    variables = await _load_for_branch(
        session, Variable, project_id, source_branch_id
    )
    for var in variables:
        new_objs.append(
            Variable(
                id=uuid.uuid4(),
                project_id=project_id,
                branch_id=target_branch_id,
                name=var.name,
                source_name=var.source_name,
                variable_type=var.variable_type,
                description=var.description,
            )
        )

    events = (
        (
            await session.execute(
                select(Event)
                .where(Event.project_id == project_id, Event.branch_id == source_branch_id)
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
    event_id_map: dict[uuid.UUID, uuid.UUID] = {}
    for ev in events:
        new_ev_id = uuid.uuid4()
        event_id_map[ev.id] = new_ev_id
        new_objs.append(
            Event(
                id=new_ev_id,
                project_id=project_id,
                branch_id=target_branch_id,
                event_type_id=et_map[ev.event_type_id],
                name=ev.name,
                description=ev.description,
                order=ev.order,
                implemented=ev.implemented,
                reviewed=ev.reviewed,
                archived=ev.archived,
                last_seen_at=ev.last_seen_at,
                metric_breakdown_columns=list(ev.metric_breakdown_columns or []),
            )
        )
        for fv in ev.field_values:
            new_objs.append(
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=new_ev_id,
                    field_definition_id=fd_map[fv.field_definition_id],
                    value=fv.value,
                )
            )
        for mv in ev.meta_values:
            new_objs.append(
                EventMetaValue(
                    id=uuid.uuid4(),
                    event_id=new_ev_id,
                    meta_field_definition_id=mf_map[mv.meta_field_definition_id],
                    value=mv.value,
                )
            )
        for tag in ev.tags:
            new_objs.append(EventTag(id=uuid.uuid4(), event_id=new_ev_id, name=tag.name))

    # Photos + threaded comments. Reuse storage_key/external_url so blobs aren't
    # duplicated: branch and main rows reference the same underlying object.
    if event_id_map:
        source_event_ids = list(event_id_map.keys())
        photos = (
            (
                await session.execute(
                    select(EventPhoto)
                    .where(EventPhoto.event_id.in_(source_event_ids))
                    .order_by(EventPhoto.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        photo_id_map: dict[uuid.UUID, uuid.UUID] = {}
        for ph in photos:
            new_ph_id = uuid.uuid4()
            photo_id_map[ph.id] = new_ph_id
            new_objs.append(
                EventPhoto(
                    id=new_ph_id,
                    project_id=ph.project_id,
                    event_id=event_id_map[ph.event_id],
                    uploaded_by_user_id=ph.uploaded_by_user_id,
                    original_filename=ph.original_filename,
                    content_type=ph.content_type,
                    size_bytes=ph.size_bytes,
                    kind=ph.kind,
                    external_url=ph.external_url,
                    storage_backend=ph.storage_backend,
                    storage_key=ph.storage_key,
                    sort_order=ph.sort_order,
                )
            )
        if photo_id_map:
            comments = (
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
            for c in comments:
                new_c_id = uuid.uuid4()
                comment_id_map[c.id] = new_c_id
                new_objs.append(
                    EventPhotoComment(
                        id=new_c_id,
                        photo_id=photo_id_map[c.photo_id],
                        parent_id=(
                            comment_id_map.get(c.parent_id) if c.parent_id is not None else None
                        ),
                        user_id=c.user_id,
                        body=c.body,
                    )
                )

    relations = await _load_for_branch(
        session, EventTypeRelation, project_id, source_branch_id
    )
    for rel in relations:
        new_objs.append(
            EventTypeRelation(
                id=uuid.uuid4(),
                project_id=project_id,
                branch_id=target_branch_id,
                source_event_type_id=et_map[rel.source_event_type_id],
                target_event_type_id=et_map[rel.target_event_type_id],
                source_field_id=fd_map[rel.source_field_id],
                target_field_id=fd_map[rel.target_field_id],
                relation_type=rel.relation_type,
                description=rel.description,
            )
        )

    session.add_all(new_objs)


async def create_branch(
    session: AsyncSession,
    slug: str,
    data: PlanBranchCreate,
    *,
    user_id: uuid.UUID | None = None,
) -> PlanBranchResponse:
    project = await _resolve_project(session, slug)
    main_branch_id = await ensure_main_branch_id(session, project.id)

    dup = await session.scalar(
        select(PlanBranch.id).where(
            PlanBranch.project_id == project.id,
            PlanBranch.name == data.name,
        )
    )
    if dup is not None:
        raise HTTPException(status_code=409, detail="Branch with this name already exists")

    # Capture the main snapshot as the merge base.
    base_payload = await build_plan_snapshot(session, project.id, branch_id=main_branch_id)
    base_revision = PlanRevision(
        project_id=project.id,
        created_by=user_id,
        summary=f"Base snapshot for branch '{data.name}'",
        payload=base_payload,
    )
    session.add(base_revision)
    await session.flush()

    branch = PlanBranch(
        project_id=project.id,
        name=data.name,
        kind=BranchKind.working.value,
        status=BranchStatus.draft.value,
        description=data.description,
        base_revision_id=base_revision.id,
        created_by=user_id,
    )
    session.add(branch)
    await session.flush()

    await _deep_copy_plan(
        session,
        project_id=project.id,
        source_branch_id=main_branch_id,
        target_branch_id=branch.id,
    )
    await session.commit()
    await session.refresh(branch)
    return _to_response(branch)


async def delete_branch(session: AsyncSession, slug: str, branch_id: uuid.UUID) -> None:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    if branch.kind == BranchKind.main.value:
        raise HTTPException(status_code=400, detail="The main branch cannot be deleted")
    await session.delete(branch)
    await session.commit()


def _reject_main(branch: PlanBranch) -> None:
    if branch.kind == BranchKind.main.value:
        raise HTTPException(
            status_code=400, detail="The main branch has no review workflow"
        )


async def transition_branch(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID,
    action: BranchTransitionAction,
    user_id: uuid.UUID,
) -> PlanBranchDetailResponse:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    _reject_main(branch)
    if branch.status == BranchStatus.merged.value:
        raise HTTPException(status_code=400, detail="Merged branches are immutable")

    allowed_from, target = _TRANSITIONS[action]
    if branch.status not in allowed_from:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot {action} from status '{branch.status}'",
        )

    branch.status = target

    if action in _APPROVAL_CLEARING_ACTIONS:
        await session.execute(
            delete(PlanBranchApproval).where(PlanBranchApproval.branch_id == branch.id)
        )
        # Same lifecycle as approvals: once the branch goes back into draft /
        # changes-requested / ready-for-review, prior per-field merge choices
        # don't survive — the reviewer makes a fresh round of picks against
        # the new base/ours/theirs.
        await session.execute(
            delete(PlanBranchMergeResolution).where(
                PlanBranchMergeResolution.branch_id == branch.id
            )
        )

    if action == "approve":
        # Upsert: re-approving by the same user just refreshes the timestamp.
        existing = await session.scalar(
            select(PlanBranchApproval).where(
                PlanBranchApproval.branch_id == branch.id,
                PlanBranchApproval.user_id == user_id,
            )
        )
        if existing is None:
            session.add(PlanBranchApproval(branch_id=branch.id, user_id=user_id))

    await session.commit()
    await session.refresh(branch)
    return await _to_detail(session, branch)


async def _resolve_user(session: AsyncSession, user_id: uuid.UUID) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


async def add_reviewer(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID,
    data: BranchReviewerCreate,
) -> BranchReviewerResponse:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    _reject_main(branch)
    await _resolve_user(session, data.user_id)
    existing = await session.scalar(
        select(PlanBranchReviewer).where(
            PlanBranchReviewer.branch_id == branch.id,
            PlanBranchReviewer.user_id == data.user_id,
        )
    )
    if existing is not None:
        return BranchReviewerResponse.model_validate(existing)
    reviewer = PlanBranchReviewer(branch_id=branch.id, user_id=data.user_id)
    session.add(reviewer)
    await session.commit()
    await session.refresh(reviewer)
    return BranchReviewerResponse.model_validate(reviewer)


async def remove_reviewer(
    session: AsyncSession, slug: str, branch_id: uuid.UUID, user_id: uuid.UUID
) -> None:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    _reject_main(branch)
    reviewer = await session.scalar(
        select(PlanBranchReviewer).where(
            PlanBranchReviewer.branch_id == branch.id,
            PlanBranchReviewer.user_id == user_id,
        )
    )
    if reviewer is None:
        raise HTTPException(status_code=404, detail="Reviewer not assigned")
    await session.delete(reviewer)
    await session.commit()


async def list_comments(
    session: AsyncSession, slug: str, branch_id: uuid.UUID
) -> list[BranchCommentResponse]:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    rows = (
        (
            await session.execute(
                select(PlanBranchComment)
                .where(PlanBranchComment.branch_id == branch.id)
                .order_by(PlanBranchComment.created_at)
            )
        )
        .scalars()
        .all()
    )
    return [BranchCommentResponse.model_validate(c) for c in rows]


async def create_comment(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID,
    data: BranchCommentCreate,
    user_id: uuid.UUID,
) -> BranchCommentResponse:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    if data.parent_id is not None:
        parent = await session.get(PlanBranchComment, data.parent_id)
        if parent is None or parent.branch_id != branch.id:
            raise HTTPException(status_code=404, detail="Parent comment not found")
    comment = PlanBranchComment(
        branch_id=branch.id,
        parent_id=data.parent_id,
        user_id=user_id,
        body=data.body,
    )
    session.add(comment)
    await session.commit()
    await session.refresh(comment)
    return BranchCommentResponse.model_validate(comment)


async def delete_comment(
    session: AsyncSession, slug: str, branch_id: uuid.UUID, comment_id: uuid.UUID
) -> None:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    comment = await session.get(PlanBranchComment, comment_id)
    if comment is None or comment.branch_id != branch.id:
        raise HTTPException(status_code=404, detail="Comment not found")
    await session.delete(comment)
    await session.commit()


def _summary_counts(entries: list) -> dict[str, int]:
    out = {"added": 0, "removed": 0, "changed": 0}
    for entry in entries:
        out[entry.kind] += 1
    return out


async def diff_branch(
    session: AsyncSession, slug: str, branch_id: uuid.UUID
) -> PlanBranchDiff:
    project = await _resolve_project(session, slug)
    branch = await _get_branch(session, project.id, branch_id)
    _reject_main(branch)
    main_branch_id = await ensure_main_branch_id(session, project.id)

    main_snapshot = await build_plan_snapshot(session, project.id, branch_id=main_branch_id)
    branch_snapshot = await build_plan_snapshot(session, project.id, branch_id=branch.id)
    # old = main, new = branch — entries describe what the branch changes vs main.
    entries = compute_plan_diff_entries(main_snapshot, branch_snapshot)

    behind_base = False
    if branch.base_revision_id is not None:
        base_revision = await session.get(PlanRevision, branch.base_revision_id)
        if base_revision is not None:
            base_payload = base_revision.payload or {}
            behind_entries = compute_plan_diff_entries(base_payload, main_snapshot)
            behind_base = len(behind_entries) > 0

    return PlanBranchDiff(
        entries=entries,
        summary=_summary_counts(entries),
        behind_base=behind_base,
    )


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


def _event_type_add_remove_conflicts(
    base: dict, ours: dict, theirs: dict
) -> list[dict]:
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
        if ours_changed and theirs_changed and not _entities_equal(
            o, t, _ET_CHANGE_KEYS
        ):
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


async def _apply_merge(
    session: AsyncSession,
    project_id: uuid.UUID,
    main_branch_id: uuid.UUID,
    branch_id: uuid.UUID,
    *,
    resolutions: dict[tuple[str, str, str], str] | None = None,
    base_payload: dict | None = None,
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
    base_et_by_name: dict[str, dict] = {
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
    main_mfs = await _load_for_branch(
        session, MetaFieldDefinition, project_id, main_branch_id
    )
    branch_mfs = await _load_for_branch(
        session, MetaFieldDefinition, project_id, branch_id
    )
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
        for mf in await _load_for_branch(
            session, MetaFieldDefinition, project_id, main_branch_id
        )
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
    main_event_by_key = {
        (main_et_id_to_name[e.event_type_id], e.name): e for e in main_events
    }
    branch_event_by_key = {
        (branch_et_id_to_name[e.event_type_id], e.name): e for e in branch_events
    }

    for key, b_ev in branch_event_by_key.items():
        et_name, _ev_name = key
        if key in main_event_by_key:
            m_ev = main_event_by_key[key]
            m_ev.description = b_ev.description
            m_ev.implemented = b_ev.implemented
            m_ev.reviewed = b_ev.reviewed
            m_ev.archived = b_ev.archived
            m_ev.order = b_ev.order
            m_ev.metric_breakdown_columns = list(b_ev.metric_breakdown_columns or [])
            # Rebuild children
            await session.execute(
                delete(EventFieldValue).where(EventFieldValue.event_id == m_ev.id)
            )
            await session.execute(
                delete(EventMetaValue).where(EventMetaValue.event_id == m_ev.id)
            )
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
                    description=b_ev.description,
                    order=b_ev.order,
                    implemented=b_ev.implemented,
                    reviewed=b_ev.reviewed,
                    archived=b_ev.archived,
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
        et_name = main_et_id_to_name.get(e.event_type_id)
        if et_name is not None:
            main_event_key_to_id[(et_name, e.name)] = e.id

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
                            comment_id_map.get(bc.parent_id)
                            if bc.parent_id is not None
                            else None
                        ),
                        user_id=bc.user_id,
                        body=bc.body,
                    )
                )
            await session.flush()

    # --- relations: wholesale replace on main using name-based FK remap
    branch_relations = await _load_for_branch(
        session, EventTypeRelation, project_id, branch_id
    )
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


def _touched_event_type_names(base_payload: dict, branch_payload: dict) -> set[str]:
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
    base_payload: dict,
    branch_payload: dict,
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
        select(PlanBranchApproval.user_id).where(
            PlanBranchApproval.branch_id == branch_id
        )
    )
    approver_ids = {row[0] for row in approvals.all()}

    missing: list[dict] = []
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
        raise HTTPException(
            status_code=409, detail="Branch must be approved before merging"
        )

    main_branch_id = await ensure_main_branch_id(session, project.id)
    base_payload: dict = {}
    if branch.base_revision_id is not None:
        base_rev = await session.get(PlanRevision, branch.base_revision_id)
        if base_rev is not None:
            base_payload = base_rev.payload or {}
    main_payload = await build_plan_snapshot(session, project.id, branch_id=main_branch_id)
    branch_payload = await build_plan_snapshot(session, project.id, branch_id=branch.id)

    all_conflicts = _detect_merge_conflicts(base_payload, main_payload, branch_payload)
    field_conflicts = _field_conflicts_event_type(
        base_payload, main_payload, branch_payload
    )
    # Modify-modify clashes on event_type fields are surfaced via the inline
    # resolution flow; entity-level adds/removes and conflicts on other entity
    # kinds stay hard blockers — they aren't covered by v1 resolutions.
    resolvable = {(c["entity_type"], c["name"]) for c in field_conflicts}
    blocking = [
        c for c in all_conflicts if (c["entity_type"], c["name"]) not in resolvable
    ]
    if blocking:
        raise HTTPException(status_code=409, detail={"conflicts": blocking})

    resolution_map: dict[tuple[str, str, str], str] = {}
    if field_conflicts:
        resolutions = await _load_resolutions(session, branch.id)
        unresolved: list[dict] = []
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
