import uuid
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.database import get_session
from tripl.middleware.branch_context import bound_branch
from tripl.models.plan_branch import BranchKind, PlanBranch
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


def _owner_gate(request: Request, user: User, *, key_reachable: bool) -> User:
    """The whole owner rule, in one place, with exactly one flag to differ on.

    Both owner gates below call this: they must never drift on the role or scope
    checks, only on whether a Bearer token is admitted at all.
    """
    require_write_scope(request)
    require_owner(user)
    if not key_reachable and getattr(request.state, "api_key_scope", None) is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Owner session required",
        )
    return user


async def get_owner_user(request: Request, user: CurrentUserDep) -> User:
    """The strict owner gate: owner role **and** an interactive browser session.

    An API key is refused whatever its scope and whoever owns it, because
    "owner-only" here means security and instance administration — minting users
    and invitations, warehouse credentials, instance settings, the audit feed,
    authoring the SQL a scan runs, deleting a project. A leaked ``tk_w_`` must not
    be able to invite a member or point a warehouse credential at a new query, so
    those stay browser-only.

    This is the default owner gate; :func:`get_key_reachable_owner_user` is the
    narrow, enumerated exception. Reach for this one unless the owner has
    explicitly decided a specific route is agent-safe.
    """
    return _owner_gate(request, user, key_reachable=False)


async def get_key_reachable_owner_user(request: Request, user: CurrentUserDep) -> User:
    """The owner gate an agent can pass: owner **role**, ``write`` scope, key OK.

    Same role and scope demands as :func:`get_owner_user` — it only drops the
    "must be a cookie session" clause, so an editor's key and any ``read`` key are
    still 403. Added for the bounded metrics replay (tripl-cj5z): no Bearer client
    could trigger one, which is why tripl-mcp ships no replay tool and the CLI
    dropped ``tripl scans replay``.

    Which routes take this gate is a security decision per route, not a
    convenience: ``test_owner_key_gates.py`` enumerates them from the live app and
    fails the build when a new route picks it up, so the exception list cannot
    grow by copy-paste.
    """
    return _owner_gate(request, user, key_reachable=True)


WriteUserDep = Annotated[User, Depends(get_write_user)]
EditorUserDep = Annotated[User, Depends(get_editor_user)]
OwnerUserDep = Annotated[User, Depends(get_owner_user)]
KeyReachableOwnerUserDep = Annotated[User, Depends(get_key_reachable_owner_user)]

# The route audits in tests/ classify every route by the gate it carries. Each
# audit used to spell its own literal set of gate functions, so adding a gate
# meant remembering every copy — and a forgotten copy does not fail, it silently
# reclassifies the new route as ungated. Spelled once here, next to the gates
# themselves, so a new gate is added in the same edit that defines it.
WRITE_GATES = frozenset(
    {get_write_user, get_editor_user, get_owner_user, get_key_reachable_owner_user}
)
# Gates that resolve the path's project as well as the caller's role:
# ``get_editor_user`` runs :func:`require_project_mutation_access`, and the two
# owner gates demand the instance-owner role, which passes it by definition.
PROJECT_SCOPED_GATES = frozenset({get_editor_user, get_owner_user, get_key_reachable_owner_user})


async def get_branch_id_override(
    request: Request,
    session: SessionDep,
    branch: Annotated[
        str | None,
        Query(description="Plan branch id (UUID) to read and write instead of the main branch."),
    ] = None,
) -> AsyncIterator[uuid.UUID | None]:
    """Resolve the editor's active branch from the ``?branch=`` query param.

    Yields ``None`` when no override is supplied (services then default to the
    project's main branch). Validates that the branch belongs to the project
    referenced by the path's ``slug`` so cross-project ids can't leak through.

    Declared as a parameter rather than read off ``request.query_params`` so
    FastAPI propagates it into the OpenAPI schema of every route carrying
    :data:`BranchIdDep` — otherwise the one documented way to keep agent edits
    off the live plan is invisible to every generated client (tripl-l33u.7).
    Typed ``str`` and parsed here on purpose: FastAPI's own ``uuid.UUID``
    coercion answers a malformed value with 422, and the published contract for
    this parameter is 400.

    A generator rather than a plain ``async def`` because this is also the ONE
    place that binds the request's branch for ``audit_service.record`` — see
    :mod:`tripl.middleware.branch_context` — and the binding needs a teardown
    point. Every raise below stays ahead of the first ``yield``, so the 400 and
    404 contracts are unchanged. A yield dependency's teardown runs in the same
    task, and so the same ``Context``, as its setup (fastapi/routing.py enters
    and exits ``request_stack`` inside one coroutine), which is what makes
    ``ContextVar.reset`` valid here; that has only been true since FastAPI
    0.106, and the pin is 0.141.1.
    """
    if not branch:
        # Unbound rather than bound-to-None: a route with no ``?branch=`` is
        # main, which is what the contextvar's default already says.
        yield None
        return
    try:
        branch_id = uuid.UUID(branch)
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
    plan_branch = await session.scalar(
        select(PlanBranch)
        .join(Project, Project.id == PlanBranch.project_id)
        .where(PlanBranch.id == branch_id, Project.slug == slug)
    )
    if plan_branch is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Branch not found",
        )
    if plan_branch.kind == BranchKind.main.value:
        # ``GET /branches`` hands a caller main's own id (list_branches returns
        # the kind="main" row), and passing it back here is accepted. Main is
        # spelled as the absence of a branch everywhere else — audit_service,
        # the audit tab's chip, the CLI's "there is no literal for main" — so
        # binding it would spell it a second way and make two identical writes
        # to main render differently in the same compliance trail
        # (tripl-wkwv.6). The id still yields unchanged: the write targets main
        # exactly as it does with no ``?branch=`` at all.
        yield plan_branch.id
        return
    # The name comes free — the query above already loads the whole row — and it
    # is what keeps an audit entry readable after the branch is deleted.
    with bound_branch(plan_branch.id, plan_branch.name):
        yield plan_branch.id


BranchIdDep = Annotated[uuid.UUID | None, Depends(get_branch_id_override)]
