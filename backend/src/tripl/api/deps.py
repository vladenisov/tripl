from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.database import get_session
from tripl.models.user import User
from tripl.services.auth_service import get_user_by_session_token

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def get_current_user(request: Request, session: SessionDep) -> User:
    session_token = request.cookies.get(settings.session_cookie_name)
    if session_token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    user = await get_user_by_session_token(session, session_token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    return user


CurrentUserDep = Annotated[User, Depends(get_current_user)]


def require_editor(user: User) -> None:
    """Reject viewers — mutations need editor role or above."""
    if user.role == "viewer":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Editor role required",
        )


def require_owner(user: User) -> None:
    """Reject anyone below owner — user management is owner-only."""
    if user.role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Owner role required",
        )


async def get_editor_user(user: CurrentUserDep) -> User:
    require_editor(user)
    return user


async def get_owner_user(user: CurrentUserDep) -> User:
    require_owner(user)
    return user


EditorUserDep = Annotated[User, Depends(get_editor_user)]
OwnerUserDep = Annotated[User, Depends(get_owner_user)]
