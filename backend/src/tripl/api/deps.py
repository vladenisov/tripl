import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.database import get_session
from tripl.models.plan_branch import PlanBranch
from tripl.models.project import Project
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


async def get_branch_id_override(
    request: Request, session: SessionDep
) -> uuid.UUID | None:
    """Resolve the editor's active branch from the ``?branch=`` query param.

    Returns ``None`` when no override is supplied (services then default to the
    project's main branch). Validates that the branch belongs to the project
    referenced by the path's ``slug`` so cross-project ids can't leak through.
    """
    branch_raw = request.query_params.get("branch")
    if not branch_raw:
        return None
    try:
        branch_id = uuid.UUID(branch_raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid branch id",
        ) from exc
    slug = request.path_params.get("slug")
    if not slug:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Branch context requires a project slug in the path",
        )
    branch = await session.scalar(
        select(PlanBranch)
        .join(Project, Project.id == PlanBranch.project_id)
        .where(PlanBranch.id == branch_id, Project.slug == slug)
    )
    if branch is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Branch not found",
        )
    return branch.id


BranchIdDep = Annotated[uuid.UUID | None, Depends(get_branch_id_override)]
