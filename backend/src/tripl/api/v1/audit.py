from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query

from tripl.api.deps import SessionDep
from tripl.schemas.audit import AuditListResponse
from tripl.services import audit_service

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=AuditListResponse)
async def list_audit(
    session: SessionDep,
    project_slug: Annotated[str | None, Query()] = None,
    action: Annotated[str | None, Query()] = None,
    user_id: Annotated[uuid.UUID | None, Query()] = None,
    since: Annotated[datetime | None, Query()] = None,
    until: Annotated[datetime | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AuditListResponse:
    return await audit_service.list_entries(
        session,
        project_slug=project_slug,
        action=action,
        user_id=user_id,
        since=since,
        until=until,
        limit=limit,
        offset=offset,
    )
