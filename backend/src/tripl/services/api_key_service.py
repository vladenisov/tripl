"""User-issued API keys for non-browser clients (LLM agents, CLI scripts).

The raw token shape is ``tk_<scope-letter>_<24 url-safe random chars>`` so the
prefix the UI shows in lists tells the operator at a glance which scope a key
carries without exposing the secret. Only the sha-256 hash of the raw token
is stored — a leaked DB dump can't replay tokens.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.api_key import ApiKey

ALLOWED_SCOPES = ("read", "write")
_PREFIX = "tk_"
_RANDOM_LEN = 24


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _generate_token(scope: str) -> tuple[str, str]:
    """Return ``(raw_token, key_prefix)``.

    Embeds the scope letter in the token so support can eyeball which scope
    a leaked key carried without DB access (e.g. ``tk_r_...`` vs ``tk_w_...``).
    """
    body = secrets.token_urlsafe(_RANDOM_LEN)
    raw = f"{_PREFIX}{scope[0]}_{body}"
    return raw, raw[: len(_PREFIX) + 2 + 6]  # tk_<scope>_<first 6 chars>


async def list_keys(session: AsyncSession, user_id: uuid.UUID) -> list[ApiKey]:
    rows = await session.execute(
        select(ApiKey)
        .where(ApiKey.user_id == user_id)
        .order_by(ApiKey.created_at.desc())
    )
    return list(rows.scalars().all())


async def create_key(
    session: AsyncSession,
    user_id: uuid.UUID,
    *,
    name: str,
    scope: str,
    expires_in_days: int | None,
) -> tuple[ApiKey, str]:
    """Create a key row and return ``(row, raw_token)``.

    The raw token is only ever surfaced once — the row carries the prefix
    plus the hash, so callers should display the raw token to the operator
    immediately and never again.
    """
    if scope not in ALLOWED_SCOPES:
        raise HTTPException(
            status_code=422, detail=f"scope must be one of {list(ALLOWED_SCOPES)}"
        )
    normalized_name = name.strip()
    if not normalized_name:
        raise HTTPException(status_code=422, detail="name is required")
    if expires_in_days is not None and expires_in_days <= 0:
        raise HTTPException(status_code=422, detail="expires_in_days must be > 0")

    raw, prefix = _generate_token(scope)
    expires_at = (
        datetime.now(UTC) + timedelta(days=expires_in_days)
        if expires_in_days is not None
        else None
    )
    row = ApiKey(
        user_id=user_id,
        name=normalized_name,
        key_prefix=prefix,
        key_hash=_hash_token(raw),
        scope=scope,
        expires_at=expires_at,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row, raw


async def revoke_key(
    session: AsyncSession, user_id: uuid.UUID, key_id: uuid.UUID
) -> None:
    """Mark a key revoked. Idempotent: revoking an already-revoked row is a no-op."""
    row = await session.get(ApiKey, key_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="API key not found")
    if row.revoked_at is not None:
        return
    row.revoked_at = datetime.now(UTC)
    await session.commit()


async def verify_and_touch(session: AsyncSession, raw_token: str) -> ApiKey | None:
    """Resolve a raw bearer token to its (live, non-expired, non-revoked) row.

    Updates ``last_used_at`` on a successful hit so the UI can show recent
    activity. Returns ``None`` if the token is unknown / revoked / expired so
    the caller picks the rejection reason (we don't want to leak which case
    it is in error responses)."""
    if not raw_token.startswith(_PREFIX):
        return None
    row = await session.scalar(
        select(ApiKey).where(ApiKey.key_hash == _hash_token(raw_token))
    )
    if row is None:
        return None
    if row.revoked_at is not None:
        return None
    if row.expires_at is not None and row.expires_at <= datetime.now(UTC):
        return None
    row.last_used_at = datetime.now(UTC)
    await session.commit()
    return row
