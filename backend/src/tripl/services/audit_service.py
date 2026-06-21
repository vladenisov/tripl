from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, cast

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.audit_log import AuditLog
from tripl.models.project import Project
from tripl.models.user import User
from tripl.schemas.audit import AuditEntryResponse, AuditListResponse

# Fields that must never make it into the audit payload — credentials, hashes,
# anything you would not want to read back from the audit UI in cleartext.
# Matching is exact-key (no substring); the alerting destination secrets below
# don't fit the generic password/token/secret names, so they're listed by name.
_REDACTED_KEYS = frozenset(
    {
        "password",
        "password_encrypted",
        "password_hash",
        "secret",
        "token",
        "credentials",
        # Alerting destination secrets (AlertDestinationCreate).
        "webhook_url",
        "bot_token",
        "target_url",
        "webhook_header_value",
        "jira_api_token",
        "linear_api_key",
    }
)


def _jsonable(payload: dict[str, Any]) -> dict[str, Any]:
    """Round-trip through JSON to coerce UUIDs, datetimes, enums to primitives."""
    return cast(dict[str, Any], json.loads(json.dumps(payload, default=str)))


def _redact(payload: dict[str, Any]) -> dict[str, Any]:
    return {k: ("***" if k in _REDACTED_KEYS else v) for k, v in payload.items()}


async def record(
    session: AsyncSession,
    *,
    user: User | None,
    action: str,
    target_type: str,
    target_id: uuid.UUID | None,
    target_name: str = "",
    project: Project | None = None,
    project_slug: str | None = None,
    payload: dict[str, Any] | None = None,
) -> AuditLog:
    project_id: uuid.UUID | None
    slug = ""
    if project is not None:
        project_id = project.id
        slug = project.slug
    elif project_slug:
        row = (
            await session.execute(
                select(Project.id, Project.slug).where(Project.slug == project_slug)
            )
        ).one_or_none()
        if row is None:
            project_id = None
            slug = project_slug
        else:
            project_id, slug = row
    else:
        project_id = None

    entry = AuditLog(
        user_id=user.id if user else None,
        user_email=user.email if user else "",
        project_id=project_id,
        project_slug=slug,
        action=action,
        target_type=target_type,
        target_id=target_id,
        target_name=target_name or "",
        payload=_redact(_jsonable(payload or {})),
    )
    session.add(entry)
    await session.commit()
    return entry


async def list_entries(
    session: AsyncSession,
    *,
    project_slug: str | None = None,
    action: str | None = None,
    user_id: uuid.UUID | None = None,
    user_email: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 50,
    offset: int = 0,
) -> AuditListResponse:
    base = select(AuditLog)
    count_base = select(func.count()).select_from(AuditLog)

    if project_slug:
        base = base.where(AuditLog.project_slug == project_slug)
        count_base = count_base.where(AuditLog.project_slug == project_slug)
    if action:
        base = base.where(AuditLog.action == action)
        count_base = count_base.where(AuditLog.action == action)
    if user_id:
        base = base.where(AuditLog.user_id == user_id)
        count_base = count_base.where(AuditLog.user_id == user_id)
    if user_email:
        needle = f"%{user_email.lower()}%"
        base = base.where(func.lower(AuditLog.user_email).like(needle))
        count_base = count_base.where(func.lower(AuditLog.user_email).like(needle))
    if since:
        base = base.where(AuditLog.created_at >= since)
        count_base = count_base.where(AuditLog.created_at >= since)
    if until:
        base = base.where(AuditLog.created_at < until)
        count_base = count_base.where(AuditLog.created_at < until)

    rows = (
        (
            await session.execute(
                base.order_by(desc(AuditLog.created_at)).limit(limit).offset(offset)
            )
        )
        .scalars()
        .all()
    )
    total = int(await session.scalar(count_base) or 0)
    return AuditListResponse(
        items=[AuditEntryResponse.model_validate(r) for r in rows],
        total=total,
    )
