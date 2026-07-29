from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from tripl.api.deps import SessionDep, get_owner_user
from tripl.schemas.audit import AuditListResponse
from tripl.services import audit_service

# Owner-only: this feed was the back door around two other owner-only gates.
#
# Every entry carries the request payload that produced it, and the router had
# nothing but the shared auth dependency, so any authenticated user could read:
#
#   * ``data_source.create`` / ``.update`` payloads — the warehouse host, port,
#     database and username that data_sources.py:69 deliberately BLANKS for
#     non-owners on every direct read of the same source;
#   * ``scan_config.create`` payloads — ``base_query``, the free-text SQL that
#     authoring a scan is owner-only to protect (api/v1/scans.py:36), since it
#     reads whatever the warehouse credential can.
#
# The log is also INSTANCE-wide — ``project_slug`` is a filter, not a scope — so
# the reach was every project, not just the caller's. Passwords were never
# exposed; audit_service._redact strips them (tripl-jfm3.110).
router = APIRouter(prefix="/audit", tags=["audit"], dependencies=[Depends(get_owner_user)])


@router.get("", response_model=AuditListResponse)
async def list_audit(
    session: SessionDep,
    project_slug: Annotated[str | None, Query()] = None,
    action: Annotated[str | None, Query()] = None,
    user_id: Annotated[uuid.UUID | None, Query()] = None,
    user_email: Annotated[str | None, Query()] = None,
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
        user_email=user_email,
        since=since,
        until=until,
        limit=limit,
        offset=offset,
    )
