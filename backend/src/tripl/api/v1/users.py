from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from tripl.api.deps import CurrentUserDep, SessionDep, require_owner
from tripl.models.user import User
from tripl.schemas.auth import UserListItem, UserRoleUpdate
from tripl.services import audit_service

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserListItem])
async def list_users(session: SessionDep, current_user: CurrentUserDep) -> list[User]:
    del current_user  # any authenticated user can see the roster
    rows = await session.scalars(select(User).order_by(User.created_at))
    return list(rows)


@router.patch("/{user_id}", response_model=UserListItem)
async def update_user_role(
    session: SessionDep,
    user_id: uuid.UUID,
    data: UserRoleUpdate,
    current_user: CurrentUserDep,
) -> User:
    require_owner(current_user)
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
