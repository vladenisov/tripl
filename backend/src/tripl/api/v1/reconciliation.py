from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from tripl.api.deps import BranchIdDep, EditorUserDep, SessionDep
from tripl.models.domain_enums import ShadowEventStatus
from tripl.schemas.reconciliation import (
    CoverageResponse,
    DeadEventListResponse,
    ShadowEventAcceptRequest,
    ShadowEventAcceptResponse,
    ShadowEventDismissResponse,
    ShadowEventListResponse,
)
from tripl.services import reconciliation_service
from tripl.services.reconciliation_service import (
    DeadEventArchiveRequest,
    DeadEventArchiveResponse,
)

router = APIRouter(prefix="/projects/{slug}/reconciliation", tags=["reconciliation"])


@router.get("/shadow-events", response_model=ShadowEventListResponse)
async def list_shadow_events(
    session: SessionDep,
    slug: str,
    status: Annotated[ShadowEventStatus | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> ShadowEventListResponse:
    return await reconciliation_service.list_shadow_events(
        session,
        slug,
        status=status,
        limit=limit,
    )


@router.post(
    "/shadow-events/{candidate_id}/accept",
    response_model=ShadowEventAcceptResponse,
)
async def accept_shadow_event(
    session: SessionDep,
    slug: str,
    candidate_id: uuid.UUID,
    payload: ShadowEventAcceptRequest,
    branch_id: BranchIdDep,
    current_user: EditorUserDep,
) -> ShadowEventAcceptResponse:
    return await reconciliation_service.accept_shadow_event(
        session,
        slug,
        candidate_id,
        payload,
        user_id=current_user.id,
        branch_id=branch_id,
    )


@router.post(
    "/shadow-events/{candidate_id}/dismiss",
    response_model=ShadowEventDismissResponse,
)
async def dismiss_shadow_event(
    session: SessionDep,
    slug: str,
    candidate_id: uuid.UUID,
    current_user: EditorUserDep,
) -> ShadowEventDismissResponse:
    return await reconciliation_service.dismiss_shadow_event(
        session,
        slug,
        candidate_id,
        user_id=current_user.id,
    )


@router.get("/dead-events", response_model=DeadEventListResponse)
async def list_dead_events(
    session: SessionDep,
    slug: str,
    days: Annotated[int, Query(ge=1, le=365)] = reconciliation_service.DEFAULT_DEAD_EVENT_DAYS,
) -> DeadEventListResponse:
    return await reconciliation_service.list_dead_events(session, slug, days=days)


@router.post("/dead-events/archive", response_model=DeadEventArchiveResponse)
async def archive_dead_events(
    session: SessionDep,
    slug: str,
    payload: DeadEventArchiveRequest,
    branch_id: BranchIdDep,
    current_user: EditorUserDep,
) -> DeadEventArchiveResponse:
    return await reconciliation_service.archive_dead_events(
        session,
        slug,
        payload,
        user_id=current_user.id,
        branch_id=branch_id,
    )


@router.get("/coverage", response_model=CoverageResponse)
async def get_coverage(
    session: SessionDep,
    slug: str,
    days: Annotated[int, Query(ge=1, le=180)] = reconciliation_service.DEFAULT_COVERAGE_DAYS,
    scan_config_id: Annotated[uuid.UUID | None, Query()] = None,
) -> CoverageResponse:
    return await reconciliation_service.get_coverage(
        session,
        slug,
        days=days,
        scan_config_id=scan_config_id,
    )
