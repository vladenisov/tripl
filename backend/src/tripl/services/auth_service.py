from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.auth_utils import (
    hash_password,
    hash_session_token,
    new_session_token,
    normalize_email,
    verify_password,
)
from tripl.config import settings
from tripl.models.user import User
from tripl.models.user_session import UserSession
from tripl.schemas.auth import LoginRequest, RegisterRequest


def _normalize_name(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _session_expires_at() -> datetime:
    return datetime.now(UTC) + timedelta(hours=settings.session_ttl_hours)


async def _get_user_by_email(session: AsyncSession, email: str) -> User | None:
    statement = select(User).where(User.email == email)
    return cast(User | None, await session.scalar(statement))


def _current_time_for(expires_at: datetime) -> datetime:
    current_time = datetime.now(UTC)
    if expires_at.tzinfo is None:
        return current_time.replace(tzinfo=None)
    return current_time


async def _create_user_session(session: AsyncSession, user_id: uuid.UUID) -> str:
    session_token = new_session_token()
    session.add(
        UserSession(
            user_id=user_id,
            session_token_hash=hash_session_token(session_token),
            expires_at=_session_expires_at(),
        )
    )
    await session.flush()
    return session_token


async def register_user(
    session: AsyncSession, data: RegisterRequest
) -> tuple[User, str]:
    email = normalize_email(data.email)
    existing = await _get_user_by_email(session, email)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User with this email already exists",
        )

    # First registered user becomes owner so the instance always has at least
    # one operator who can manage roles; subsequent users default to editor.
    user_count = await session.scalar(select(func.count()).select_from(User))
    role = "owner" if not user_count else "editor"

    user = User(
        email=email,
        name=_normalize_name(data.name),
        password_hash=hash_password(data.password),
        role=role,
    )
    session.add(user)
    await session.flush()

    session_token = await _create_user_session(session, user.id)
    await session.commit()
    await session.refresh(user)
    return user, session_token


async def authenticate_user(
    session: AsyncSession, data: LoginRequest
) -> tuple[User, str]:
    email = normalize_email(data.email)
    user = await _get_user_by_email(session, email)
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    await session.execute(
        delete(UserSession).where(
            UserSession.user_id == user.id,
            UserSession.expires_at <= datetime.now(UTC),
        ).execution_options(synchronize_session=False)
    )
    session_token = await _create_user_session(session, user.id)
    await session.commit()
    await session.refresh(user)
    return user, session_token


async def get_user_by_session_token(
    session: AsyncSession, session_token: str
) -> User | None:
    statement = (
        select(UserSession)
        .options(selectinload(UserSession.user))
        .where(UserSession.session_token_hash == hash_session_token(session_token))
    )
    db_session = cast(UserSession | None, await session.scalar(statement))
    if db_session is None:
        return None

    if db_session.expires_at <= _current_time_for(db_session.expires_at):
        await session.delete(db_session)
        await session.commit()
        return None

    return db_session.user


async def logout_session(session: AsyncSession, session_token: str | None) -> None:
    if session_token is None:
        return

    await session.execute(
        delete(UserSession).where(
            UserSession.session_token_hash == hash_session_token(session_token)
        )
    )
    await session.commit()
