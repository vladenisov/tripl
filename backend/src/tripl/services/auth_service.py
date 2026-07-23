from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.auth_utils import (
    hash_password,
    hash_session_token,
    new_session_token,
    normalize_email,
    password_hash_needs_rehash,
    verify_password,
)
from tripl.config import settings
from tripl.models.password_reset_token import PasswordResetToken
from tripl.models.user import User
from tripl.models.user_session import UserSession
from tripl.schemas.auth import LoginRequest, RegisterRequest

# Password-reset link lifetime. Short on purpose: a reset link is a bearer
# credential, so it should be usable just long enough for a human to open their
# inbox and click through.
PASSWORD_RESET_TTL_HOURS = 1
# 32 bytes ≈ 256 bits of entropy via ``secrets.token_urlsafe`` — the same
# generator and width as session tokens, so a reset token is never guessable.
PASSWORD_RESET_TOKEN_BYTES = 32

# Single neutral message for both the "we emailed you" and "no such account"
# cases so the request endpoint never reveals whether an address is registered.
PASSWORD_RESET_NEUTRAL_MESSAGE = (
    "If an account exists for that email, a password reset link is on its way."
)
# Deliberately identical for invalid / expired / already-used tokens so confirm
# never leaks which of those a rejected token hit.
_PASSWORD_RESET_INVALID_MESSAGE = "This password reset link is invalid or has expired."

# Advisory-lock key serialising the first-user-becomes-owner decision. Constant
# (not per-row) on purpose: the thing being serialised is the global "is the
# users table empty?" check. Derived from a fixed 8-byte tag so it is stable
# across releases and unlikely to collide with the per-project locks (which
# derive their keys from UUID bytes, see demo_runtime._acquire_project_xact_lock).
_FIRST_OWNER_LOCK_KEY = int.from_bytes(b"trplown1", "big", signed=True)


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


async def has_any_users(session: AsyncSession) -> bool:
    """Whether the instance has at least one registered user.

    Single source of truth for the "fresh instance" check: powers both the
    first-user-becomes-owner rule and the unauthenticated /auth/status endpoint.
    """
    user_count = await session.scalar(select(func.count()).select_from(User))
    return bool(user_count)


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


async def _acquire_first_owner_xact_lock(session: AsyncSession) -> None:
    """Serialise the first-user-becomes-owner decision across concurrent registrations.

    Takes a constant-key transaction advisory lock BEFORE the ``has_any_users``
    check so two concurrent first registrations can't both observe an empty
    users table and both become owner (TOCTOU). PostgreSQL-only, same idiom as
    ``demo_runtime._acquire_project_xact_lock``: SQLite (tests) has no advisory
    locks, so this is a no-op there — the suite runs on a single in-memory
    connection where the race cannot occur, so tests are unaffected. The lock
    auto-releases when the surrounding transaction commits or rolls back.
    """
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:key)"),
        {"key": _FIRST_OWNER_LOCK_KEY},
    )


async def register_user(session: AsyncSession, data: RegisterRequest) -> tuple[User, str]:
    email = normalize_email(data.email)
    existing = await _get_user_by_email(session, email)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User with this email already exists",
        )

    # First registered user becomes owner so the instance always has at least
    # one operator who can manage roles; subsequent users default to editor.
    # The advisory lock closes the TOCTOU window: taken before the empty-table
    # check and held until this registration's commit, so a concurrent first
    # registration waits and then observes this user — exactly one owner.
    await _acquire_first_owner_xact_lock(session)
    role = "owner" if not await has_any_users(session) else "editor"

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


async def authenticate_user(session: AsyncSession, data: LoginRequest) -> tuple[User, str]:
    email = normalize_email(data.email)
    user = await _get_user_by_email(session, email)
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Opportunistic rehash: if the stored hash predates a scrypt-cost bump, we
    # have the plaintext in hand, so upgrade it to the current parameters now.
    if password_hash_needs_rehash(user.password_hash):
        user.password_hash = hash_password(data.password)

    await session.execute(
        delete(UserSession)
        .where(
            UserSession.user_id == user.id,
            UserSession.expires_at <= datetime.now(UTC),
        )
        .execution_options(synchronize_session=False)
    )
    session_token = await _create_user_session(session, user.id)
    await session.commit()
    await session.refresh(user)
    return user, session_token


async def get_user_by_session_token(session: AsyncSession, session_token: str) -> User | None:
    statement = (
        select(UserSession)
        .options(selectinload(UserSession.user))
        .where(UserSession.session_token_hash == hash_session_token(session_token))
    )
    db_session = cast(UserSession | None, await session.scalar(statement))
    if db_session is None:
        return None

    if db_session.expires_at <= datetime.now(UTC):
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


def _hash_reset_token(raw_token: str) -> str:
    """Digest a raw reset token for storage/lookup.

    Reuses the shared keyed-HMAC token hasher (``auth_utils.hash_session_token``)
    rather than rolling a new one: only the digest is ever persisted, so a leaked
    ``password_reset_tokens`` column is useless without ``SECRET_KEY``.
    """
    return hash_session_token(raw_token)


def _reset_expires_at() -> datetime:
    return datetime.now(UTC) + timedelta(hours=PASSWORD_RESET_TTL_HOURS)


async def _delete_reset_tokens_for_user(
    session: AsyncSession, user_id: uuid.UUID, *, exclude_id: uuid.UUID | None = None
) -> None:
    """Drop a user's outstanding reset tokens (optionally keeping ``exclude_id``).

    Keeps at most one reset link live per user: called when issuing a new token
    (supersede any earlier link) and on a successful confirm (invalidate every
    sibling of the just-consumed token).
    """
    statement = delete(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
    if exclude_id is not None:
        statement = statement.where(PasswordResetToken.id != exclude_id)
    await session.execute(statement.execution_options(synchronize_session=False))


async def request_password_reset(session: AsyncSession, email: str) -> tuple[User, str] | None:
    """Issue a single-use reset token for ``email`` when a user exists.

    Returns ``(user, raw_token)`` when an account matches — the caller emails the
    raw token — or ``None`` when no account matches. The caller responds
    identically either way, so this never reveals whether an address is
    registered. Any earlier outstanding token for the user is invalidated so only
    the newest link works.
    """
    user = await _get_user_by_email(session, normalize_email(email))
    if user is None:
        return None

    await _delete_reset_tokens_for_user(session, user.id)
    raw_token = secrets.token_urlsafe(PASSWORD_RESET_TOKEN_BYTES)
    session.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=_hash_reset_token(raw_token),
            expires_at=_reset_expires_at(),
        )
    )
    await session.commit()
    return user, raw_token


async def confirm_password_reset(session: AsyncSession, raw_token: str, new_password: str) -> None:
    """Consume a reset token and set the user's new password.

    The token must exist, be unexpired and unused. On success the password is
    re-hashed with the shared policy-enforced hasher, the token is marked used
    (single-use), every other outstanding token for the user is dropped, and all
    active sessions are cleared so a reset always ends other logins. Password
    strength is enforced upstream at the schema boundary (same policy as
    register), so an invalid password never reaches here.
    """
    row = cast(
        PasswordResetToken | None,
        await session.scalar(
            select(PasswordResetToken).where(
                PasswordResetToken.token_hash == _hash_reset_token(raw_token)
            )
        ),
    )
    now = datetime.now(UTC)
    if row is None or row.used_at is not None or row.expires_at <= now:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_PASSWORD_RESET_INVALID_MESSAGE,
        )

    user = await session.get(User, row.user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_PASSWORD_RESET_INVALID_MESSAGE,
        )

    user.password_hash = hash_password(new_password)
    row.used_at = now
    await _delete_reset_tokens_for_user(session, user.id, exclude_id=row.id)
    # A password reset invalidates existing sessions: whoever reset the password
    # gets a fresh login, and any other live session is forced to re-authenticate.
    await session.execute(
        delete(UserSession)
        .where(UserSession.user_id == user.id)
        .execution_options(synchronize_session=False)
    )
    await session.commit()
