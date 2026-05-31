"""Per-user API-key management.

Mounted under ``/api/v1/me/api-keys`` so each user manages their own keys —
no cross-user listing or revocation, even for owners. The full bearer token
is returned exactly once at creation; subsequent ``GET`` only exposes the
non-secret prefix.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter

from tripl.api.deps import CurrentUserDep, SessionDep
from tripl.schemas.api_key import (
    ApiKeyCreate,
    ApiKeyCreateResponse,
    ApiKeyResponse,
)
from tripl.services import api_key_service, audit_service

router = APIRouter(prefix="/me/api-keys", tags=["api-keys"])


@router.get("", response_model=list[ApiKeyResponse])
async def list_api_keys(
    session: SessionDep, current_user: CurrentUserDep
) -> list[ApiKeyResponse]:
    rows = await api_key_service.list_keys(session, current_user.id)
    return [ApiKeyResponse.model_validate(row) for row in rows]


@router.post("", response_model=ApiKeyCreateResponse, status_code=201)
async def create_api_key(
    session: SessionDep,
    current_user: CurrentUserDep,
    data: ApiKeyCreate,
) -> ApiKeyCreateResponse:
    row, raw_token = await api_key_service.create_key(
        session,
        current_user.id,
        name=data.name,
        scope=data.scope,
        expires_in_days=data.expires_in_days,
    )
    await audit_service.record(
        session,
        user=current_user,
        action="api_key.create",
        target_type="api_key",
        target_id=row.id,
        target_name=row.name,
        project_slug=None,
        payload={"scope": row.scope},
    )
    return ApiKeyCreateResponse(
        id=row.id,
        name=row.name,
        key_prefix=row.key_prefix,
        scope=row.scope,
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
        last_used_at=row.last_used_at,
        created_at=row.created_at,
        token=raw_token,
    )


@router.delete("/{key_id}", status_code=204)
async def revoke_api_key(
    session: SessionDep, current_user: CurrentUserDep, key_id: uuid.UUID
) -> None:
    await api_key_service.revoke_key(session, current_user.id, key_id)
    await audit_service.record(
        session,
        user=current_user,
        action="api_key.revoke",
        target_type="api_key",
        target_id=key_id,
        target_name="",
        project_slug=None,
    )
