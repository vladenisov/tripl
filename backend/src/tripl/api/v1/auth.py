from fastapi import APIRouter, Depends, Request, Response, status

from tripl.api.deps import CurrentUserDep, SessionDep
from tripl.config import settings
from tripl.middleware.rate_limit import enforce, login_rate_limiter, register_rate_limiter
from tripl.schemas.auth import AuthUserResponse, LoginRequest, RegisterRequest
from tripl.services import auth_service

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_session_cookie(response: Response, session_token: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_token,
        httponly=True,
        max_age=settings.session_ttl_hours * 60 * 60,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )


@router.post(
    "/register",
    response_model=AuthUserResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(enforce(register_rate_limiter))],
)
async def register(
    response: Response, session: SessionDep, data: RegisterRequest
) -> AuthUserResponse:
    user, session_token = await auth_service.register_user(session, data)
    _set_session_cookie(response, session_token)
    return AuthUserResponse.model_validate(user)


@router.post(
    "/login",
    response_model=AuthUserResponse,
    dependencies=[Depends(enforce(login_rate_limiter))],
)
async def login(
    response: Response, session: SessionDep, data: LoginRequest
) -> AuthUserResponse:
    user, session_token = await auth_service.authenticate_user(session, data)
    _set_session_cookie(response, session_token)
    return AuthUserResponse.model_validate(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    session: SessionDep,
    current_user: CurrentUserDep,
) -> None:
    del current_user
    await auth_service.logout_session(
        session, request.cookies.get(settings.session_cookie_name)
    )
    _clear_session_cookie(response)


@router.get("/me", response_model=AuthUserResponse)
async def get_me(current_user: CurrentUserDep) -> AuthUserResponse:
    return AuthUserResponse.model_validate(current_user)
