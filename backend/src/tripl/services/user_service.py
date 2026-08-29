"""Instance-wide user operations that are more than a read.

Role changes carry two invariants the router is the wrong place to hold: the
owner set must never empty, and a changed role must take effect on the next
request rather than whenever the old session happens to expire. Both are
enforced here so `api/v1/users.py` stays the thin layer the rest of the API is.
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.user import User
from tripl.models.user_session import UserSession
from tripl.services import auth_service


class LastOwnerError(Exception):
    """Raised when a demotion would leave the instance with no owner at all."""


async def update_role(session: AsyncSession, user_id: uuid.UUID, role: str) -> tuple[User, str]:
    """Change one user's role, returning the user and the role it used to hold.

    Raises :class:`LookupError` when no such user exists and
    :class:`LastOwnerError` when the change would empty the owner set — plain
    exceptions rather than HTTP ones, because this layer does not know it is
    behind HTTP.

    Does NOT commit: the caller commits once, after it has written its audit
    entry, so the role change and its record land together.
    """
    # Before the target is read, not just before the guard: the same constant-key
    # advisory lock that serialises the first-owner decision on the way in also
    # serialises demotion on the way out. Without it the guard below is a plain
    # check-then-write, and two concurrent demotions of the last two owners each
    # see the other as the survivor, both pass, and the instance is left with no
    # owner at all — recoverable only from the database.
    await auth_service.acquire_owner_set_xact_lock(session)

    target = await session.scalar(select(User).where(User.id == user_id))
    if target is None:
        raise LookupError(user_id)

    if target.role == "owner" and role != "owner":
        other_owner = await session.scalar(
            select(User).where(User.role == "owner", User.id != target.id)
        )
        if other_owner is None:
            raise LastOwnerError

    old_role = target.role
    target.role = role
    if role != old_role:
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

    return target, old_role
