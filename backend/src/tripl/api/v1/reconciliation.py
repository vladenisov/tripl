from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from tripl.api.deps import BranchIdDep, EditorUserDep, SessionDep
from tripl.api.v1.events import bulk_event_audit_payload
from tripl.models.domain_enums import ShadowEventStatus
from tripl.schemas.reconciliation import (
    CoverageResponse,
    DeadEventListResponse,
    ShadowEventAcceptRequest,
    ShadowEventAcceptResponse,
    ShadowEventDismissResponse,
    ShadowEventListResponse,
)
from tripl.services import audit_service, reconciliation_service
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
    result = await reconciliation_service.archive_dead_events(
        session,
        slug,
        payload,
        user_id=current_user.id,
        branch_id=branch_id,
    )
    # Audited as ``event.bulk_update``, the same action POST /events/bulk-update
    # files, because it is the same write: archive_dead_events delegates to
    # ``event_service.bulk_update_events`` to move events into a terminal
    # lifecycle state. Without this row an editor could retire 40 events from
    # Reconciliation and the audit log — which the docs describe as covering
    # every event edit — would say nothing (tripl-wkwv.10). Recorded in the
    # router, not the service, so the scan pipeline that also calls
    # event_service stays structurally unable to write audit rows; the branch
    # comes off the contextvar ``BranchIdDep`` above already bound.
    await audit_service.record(
        session,
        user=current_user,
        action="event.bulk_update",
        target_type="event",
        target_id=None,
        project_slug=slug,
        # ``result.event_ids`` is the service's deduplicated list, so ``count``
        # is the number of events actually moved and matches what the response
        # echoed to the caller.
        payload=bulk_event_audit_payload(
            result.event_ids,
            extra={"status": result.status.value},
        ),
    )
    return result


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
