import uuid

from fastapi import APIRouter, Query

from tripl.api.deps import CurrentUserDep, SessionDep
from tripl.schemas.plan_revision import (
    PlanDiff,
    PlanRevisionCreate,
    PlanRevisionDetail,
    PlanRevisionList,
)
from tripl.services import plan_revision_service

router = APIRouter(prefix="/projects/{slug}/revisions", tags=["plan-revisions"])


@router.post("", response_model=PlanRevisionDetail, status_code=201)
async def create_revision(
    session: SessionDep,
    current_user: CurrentUserDep,
    slug: str,
    data: PlanRevisionCreate,
) -> PlanRevisionDetail:
    return await plan_revision_service.create_revision(
        session, slug, data, user_id=current_user.id
    )


@router.get("", response_model=PlanRevisionList)
async def list_revisions(
    session: SessionDep,
    slug: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> PlanRevisionList:
    return await plan_revision_service.list_revisions(session, slug, offset, limit)


@router.get("/{revision_id}", response_model=PlanRevisionDetail)
async def get_revision(
    session: SessionDep, slug: str, revision_id: uuid.UUID
) -> PlanRevisionDetail:
    return await plan_revision_service.get_revision(session, slug, revision_id)


@router.get("/{revision_id}/diff", response_model=PlanDiff)
async def diff_revision(
    session: SessionDep,
    slug: str,
    revision_id: uuid.UUID,
    compare_to: uuid.UUID = Query(...),
) -> PlanDiff:
    return await plan_revision_service.diff_revisions(
        session, slug, revision_id, compare_to
    )
