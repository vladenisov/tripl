import uuid

from fastapi import APIRouter

from tripl.api.deps import EditorUserDep, SessionDep
from tripl.schemas.plan_branch import (
    BranchCommentCreate,
    BranchCommentResponse,
    BranchConflictsResponse,
    BranchRevertRequest,
    BranchReviewerCreate,
    BranchReviewerResponse,
    BranchTransitionRequest,
    PlanBranchCreate,
    PlanBranchDetailResponse,
    PlanBranchDiff,
    PlanBranchList,
    PlanBranchResponse,
    ResolutionCreate,
    ResolutionResponse,
)
from tripl.services import (
    audit_service,
    plan_branch_conflicts,
    plan_branch_merge_service,
    plan_branch_revert_service,
    plan_branch_service,
)

router = APIRouter(prefix="/projects/{slug}/branches", tags=["plan-branches"])


@router.get("", response_model=PlanBranchList)
async def list_branches(session: SessionDep, slug: str) -> PlanBranchList:
    return await plan_branch_service.list_branches(session, slug)


@router.post("", response_model=PlanBranchResponse, status_code=201)
async def create_branch(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    data: PlanBranchCreate,
) -> PlanBranchResponse:
    branch = await plan_branch_service.create_branch(session, slug, data, user_id=current_user.id)
    await audit_service.record(
        session,
        user=current_user,
        action="plan_branch.create",
        target_type="plan_branch",
        target_id=branch.id,
        target_name=branch.name,
        project_slug=slug,
        payload={"name": branch.name},
    )
    return branch


@router.get("/{branch_id}", response_model=PlanBranchDetailResponse)
async def get_branch(
    session: SessionDep, slug: str, branch_id: uuid.UUID
) -> PlanBranchDetailResponse:
    return await plan_branch_service.get_branch(session, slug, branch_id)


@router.delete("/{branch_id}", status_code=204)
async def delete_branch(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    branch_id: uuid.UUID,
) -> None:
    existing = await plan_branch_service.get_branch(session, slug, branch_id)
    await plan_branch_service.delete_branch(session, slug, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="plan_branch.delete",
        target_type="plan_branch",
        target_id=branch_id,
        target_name=existing.name,
        project_slug=slug,
    )


@router.post("/{branch_id}/transition", response_model=PlanBranchDetailResponse)
async def transition_branch(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    branch_id: uuid.UUID,
    data: BranchTransitionRequest,
) -> PlanBranchDetailResponse:
    detail = await plan_branch_service.transition_branch(
        session, slug, branch_id, data.action, user_id=current_user.id
    )
    await audit_service.record(
        session,
        user=current_user,
        action=f"plan_branch.{data.action}",
        target_type="plan_branch",
        target_id=branch_id,
        target_name=detail.name,
        project_slug=slug,
        payload={"status": detail.status},
    )
    return detail


@router.post("/{branch_id}/reviewers", response_model=BranchReviewerResponse, status_code=201)
async def add_reviewer(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    branch_id: uuid.UUID,
    data: BranchReviewerCreate,
) -> BranchReviewerResponse:
    reviewer = await plan_branch_service.add_reviewer(session, slug, branch_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="plan_branch.add_reviewer",
        target_type="plan_branch",
        target_id=branch_id,
        target_name="",
        project_slug=slug,
        payload={"user_id": str(data.user_id)},
    )
    return reviewer


@router.delete("/{branch_id}/reviewers/{user_id}", status_code=204)
async def remove_reviewer(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    branch_id: uuid.UUID,
    user_id: uuid.UUID,
) -> None:
    await plan_branch_service.remove_reviewer(session, slug, branch_id, user_id)
    await audit_service.record(
        session,
        user=current_user,
        action="plan_branch.remove_reviewer",
        target_type="plan_branch",
        target_id=branch_id,
        target_name="",
        project_slug=slug,
        payload={"user_id": str(user_id)},
    )


@router.get("/{branch_id}/comments", response_model=list[BranchCommentResponse])
async def list_comments(
    session: SessionDep, slug: str, branch_id: uuid.UUID
) -> list[BranchCommentResponse]:
    return await plan_branch_service.list_comments(session, slug, branch_id)


@router.post("/{branch_id}/comments", response_model=BranchCommentResponse, status_code=201)
async def create_comment(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    branch_id: uuid.UUID,
    data: BranchCommentCreate,
) -> BranchCommentResponse:
    return await plan_branch_service.create_comment(
        session, slug, branch_id, data, user_id=current_user.id
    )


@router.delete("/{branch_id}/comments/{comment_id}", status_code=204)
async def delete_comment(
    session: SessionDep,
    current_user: EditorUserDep,  # noqa: ARG001 — kept for editor-only auth gate
    slug: str,
    branch_id: uuid.UUID,
    comment_id: uuid.UUID,
) -> None:
    await plan_branch_service.delete_comment(session, slug, branch_id, comment_id)


@router.get("/{branch_id}/diff", response_model=PlanBranchDiff)
async def diff_branch(session: SessionDep, slug: str, branch_id: uuid.UUID) -> PlanBranchDiff:
    return await plan_branch_service.diff_branch(session, slug, branch_id)


@router.post("/{branch_id}/revert", response_model=PlanBranchDiff)
async def revert_branch_change(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    branch_id: uuid.UUID,
    data: BranchRevertRequest,
) -> PlanBranchDiff:
    diff = await plan_branch_revert_service.revert_change(session, slug, branch_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="plan_branch.revert",
        target_type="plan_branch",
        target_id=branch_id,
        target_name=data.name,
        project_slug=slug,
        payload={
            "entity_type": data.entity_type,
            "name": data.name,
            "parent": data.parent,
            "field": data.field,
        },
    )
    return diff


@router.get("/{branch_id}/conflicts", response_model=BranchConflictsResponse)
async def get_branch_conflicts(
    session: SessionDep, slug: str, branch_id: uuid.UUID
) -> BranchConflictsResponse:
    return await plan_branch_conflicts.get_branch_conflicts(session, slug, branch_id)


@router.post("/{branch_id}/resolutions", response_model=ResolutionResponse, status_code=201)
async def save_branch_resolution(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    branch_id: uuid.UUID,
    data: ResolutionCreate,
) -> ResolutionResponse:
    return await plan_branch_conflicts.save_resolution(
        session, slug, branch_id, data, user_id=current_user.id
    )


@router.delete("/{branch_id}/resolutions/{resolution_id}", status_code=204)
async def delete_branch_resolution(
    session: SessionDep,
    current_user: EditorUserDep,  # noqa: ARG001 — kept for editor-only auth gate
    slug: str,
    branch_id: uuid.UUID,
    resolution_id: uuid.UUID,
) -> None:
    await plan_branch_conflicts.delete_resolution(session, slug, branch_id, resolution_id)


@router.post("/{branch_id}/merge", response_model=PlanBranchDetailResponse)
async def merge_branch(
    session: SessionDep,
    current_user: EditorUserDep,
    slug: str,
    branch_id: uuid.UUID,
) -> PlanBranchDetailResponse:
    detail = await plan_branch_merge_service.merge_branch(
        session, slug, branch_id, user_id=current_user.id
    )
    await audit_service.record(
        session,
        user=current_user,
        action="plan_branch.merge",
        target_type="plan_branch",
        target_id=branch_id,
        target_name=detail.name,
        project_slug=slug,
        payload={"status": detail.status},
    )
    return detail
