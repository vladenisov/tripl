import uuid

from fastapi import APIRouter

from tripl.api.deps import EditorUserDep, SessionDep
from tripl.schemas.plan_branch import (
    PlanBranchCreate,
    PlanBranchList,
    PlanBranchResponse,
)
from tripl.services import audit_service, plan_branch_service

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


@router.get("/{branch_id}", response_model=PlanBranchResponse)
async def get_branch(session: SessionDep, slug: str, branch_id: uuid.UUID) -> PlanBranchResponse:
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
