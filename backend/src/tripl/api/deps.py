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
from tripl.services import api_key_service, project_service
from tripl.services.auth_service import get_user_by_session_token
from tripl.services.project_service import get_project_id_by_slug

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def _resolve_api_key_user(request: Request, session: AsyncSession) -> User | None:
    """Resolve ``Authorization: Bearer <token>`` to a User.

    Returns ``None`` when no Bearer header is present (caller falls back to
    cookie auth). Raises 401 on a malformed / revoked / expired token so we
    don't silently downgrade an explicit-but-bad token to anonymous.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    raw_token = auth.removeprefix("Bearer ").strip()
    if not raw_token:
        return None
    api_key = await api_key_service.verify_and_touch(session, raw_token)
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired API key",
        )
    # Stash on request.state so role/scope checks downstream can tell whether
    # the caller is a session user or an API-key client.
    request.state.api_key_scope = api_key.scope
    request.state.api_key_project_id = api_key.project_id
    return await session.get(User, api_key.user_id)


async def _enforce_project_scope(
    request: Request, session: AsyncSession, project_id: uuid.UUID
) -> None:
    """A project-bound API key may only touch its own ``/projects/{slug}/...``.

    Routes without a ``slug`` path param (``/me/...``, ``/users``, ...) are
    off-limits to a project-scoped key — it exists to fence an agent into one
    project, so anything instance-wide is rejected rather than silently allowed.
    """
    slug = request.path_params.get("slug")
    if not slug:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API key is scoped to a single project",
        )
    if await get_project_id_by_slug(session, slug) != project_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API key is not authorized for this project",
        )


async def get_current_user(request: Request, session: SessionDep) -> User:
    # Bearer first — agents shouldn't need to send cookies.
    api_user = await _resolve_api_key_user(request, session)
    if api_user is not None:
        project_id = getattr(request.state, "api_key_project_id", None)
        if project_id is not None:
            await _enforce_project_scope(request, session, project_id)
        return api_user

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
    """Reject anyone below owner."""
    if user.role != "owner":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Owner role required",
        )


def require_write_scope(request: Request) -> None:
    """API keys carry a scope; ``read`` keys are blocked from mutation endpoints.

    Session-authenticated users have no scope tag on request.state and so
    bypass this check — their role is the only gate.
    """
    scope = getattr(request.state, "api_key_scope", None)
    if scope == "read":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API key has read-only scope",
        )


async def get_write_user(request: Request, user: CurrentUserDep) -> User:
    require_write_scope(request)
    return user


async def require_project_mutation_access(
    request: Request, session: AsyncSession, user: User
) -> None:
    """Project-scope the instance-wide editor role.

    ``require_editor`` only answers "may this user edit *something*". Every route
    whose path carries a project ``slug`` also has to answer "…may they edit
    *this* project", otherwise an editor can rewrite the tracking plan of every
    project on the instance and inject content into other users' demos
    (tripl-jfm3.19).

    Hooked into :func:`get_editor_user` rather than sprinkled over ~20 routers on
    purpose: the mutation surface is exactly the set of slug-scoped routes that
    already carry the editor gate (no ``GET`` uses it), so doing it here closes
    the whole surface at once and keeps future routes closed by default. Routes
    without a ``slug`` (``/projects``, ``/me/...``) are unaffected, and reads stay
    open to any authenticated user.
    """
    slug = request.path_params.get("slug")
    if not slug:
        return
    scope = await project_service.get_project_mutation_scope(session, slug)
    if scope.allows(user):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            "Only the demo creator or an owner can modify this demo"
            if scope.is_demo
            else "Only the project creator or an owner can modify this project"
        ),
    )


async def get_editor_user(request: Request, session: SessionDep, user: CurrentUserDep) -> User:
    require_write_scope(request)
    require_editor(user)
    await require_project_mutation_access(request, session, user)
    return user


async def get_owner_user(request: Request, user: CurrentUserDep) -> User:
    require_write_scope(request)
    require_owner(user)
    if getattr(request.state, "api_key_scope", None) is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Owner session required",
        )
    return user


WriteUserDep = Annotated[User, Depends(get_write_user)]
EditorUserDep = Annotated[User, Depends(get_editor_user)]
OwnerUserDep = Annotated[User, Depends(get_owner_user)]


async def get_branch_id_override(request: Request, session: SessionDep) -> uuid.UUID | None:
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
