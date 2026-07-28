from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import delete, select

from tripl.api.deps import CurrentUserDep, OwnerUserDep, SessionDep
from tripl.models.user import User
from tripl.models.user_session import UserSession
from tripl.schemas.auth import UserListItem, UserRoleUpdate
from tripl.schemas.invitation import (
    InvitationCreate,
    InvitationCreatedResponse,
    InvitationResponse,
)
from tripl.services import audit_service, invitation_service

router = APIRouter(prefix="/users", tags=["users"])


@router.post(
    "/invitations",
    response_model=InvitationCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_invitation(
    session: SessionDep,
    data: InvitationCreate,
    current_user: OwnerUserDep,
) -> InvitationCreatedResponse:
    """Invite one person, at a role the owner picks.

    ``OwnerUserDep`` is owner-only AND rejects API keys of any scope, so minting
    an account always requires an interactive owner session — an automation
    token can never conjure a new identity.

    The redeem link is returned in the body, not merely emailed: SMTP is
    optional and unconfigured on many instances, so a body-only path is the one
    that always works. It appears here and nowhere else.
    """
    invitation, raw_token = await invitation_service.create_invitation(
        session,
        email=data.email,
        role=data.role,
        invited_by_user_id=current_user.id,
    )
    await audit_service.record(
        session,
        user=current_user,
        action="user.invite",
        target_type="invitation",
        target_id=invitation.id,
        target_name=invitation.email,
        payload={"role": invitation.role},
    )
    return InvitationCreatedResponse(
        invitation=InvitationResponse.model_validate(invitation),
        accept_path=f"/invite/{raw_token}",
        expires_at=invitation.expires_at,
    )


@router.get("/invitations", response_model=list[InvitationResponse])
async def list_invitations(
    session: SessionDep,
    current_user: OwnerUserDep,
) -> list[InvitationResponse]:
    """Outstanding invitations. Owner-only: this is the roster of pending access."""
    del current_user
    rows = await invitation_service.list_pending_invitations(session)
    return [InvitationResponse.model_validate(row) for row in rows]


@router.delete("/invitations/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invitation(
    session: SessionDep,
    invitation_id: uuid.UUID,
    current_user: OwnerUserDep,
) -> None:
    """Revoke an invitation; its link stops working immediately."""
    await invitation_service.revoke_invitation(session, invitation_id)
    await audit_service.record(
        session,
        user=current_user,
        action="user.invite_revoke",
        target_type="invitation",
        target_id=invitation_id,
        target_name=str(invitation_id),
        payload={},
    )


@router.get("", response_model=list[UserListItem])
async def list_users(
    session: SessionDep,
    current_user: CurrentUserDep,
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> list[User]:
    del current_user  # any authenticated user can see the roster
    rows = await session.scalars(select(User).order_by(User.created_at).limit(limit).offset(offset))
    return list(rows)


@router.patch("/{user_id}", response_model=UserListItem)
async def update_user_role(
    session: SessionDep,
    user_id: uuid.UUID,
    data: UserRoleUpdate,
    current_user: OwnerUserDep,
) -> User:
    target = await session.scalar(select(User).where(User.id == user_id))
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Guard against the only owner demoting themselves and locking the instance.
    if target.role == "owner" and data.role != "owner":
        other_owners = await session.scalar(
            select(User).where(User.role == "owner", User.id != target.id)
        )
        if other_owners is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot demote the last remaining owner",
            )
    old_role = target.role
    target.role = data.role
    if data.role != old_role:
        # A role change must take effect immediately, so drop every active
        # session for this user: auth dependencies read user.role off the
        # session-loaded instance, and a stale (e.g. demoted) session would
        # otherwise keep the old permissions until it expired. Deleting in the
        # same transaction forces the next request to re-authenticate with the
        # fresh role.
        #
        # Residual staleness window: an in-flight request that already passed
        # the auth dependency still completes with the old role; only the next
        # request is affected.
        await session.execute(delete(UserSession).where(UserSession.user_id == target.id))
    await session.commit()
    await session.refresh(target)
    await audit_service.record(
        session,
        user=current_user,
        action="user.role_update",
        target_type="user",
        target_id=target.id,
        target_name=target.email,
        payload={"old_role": old_role, "new_role": data.role},
    )
    return target
