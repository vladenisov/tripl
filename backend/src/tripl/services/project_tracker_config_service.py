from __future__ import annotations

import uuid
from collections.abc import Callable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.alerting_validation import (
    validate_jira_api_token,
    validate_jira_auth_email,
    validate_jira_base_url,
    validate_jira_issue_type,
    validate_jira_project_key,
)
from tripl.crypto import encrypt_value
from tripl.models.project_tracker_config import ProjectTrackerConfig
from tripl.schemas.project_tracker_config import (
    ProjectTrackerConfigResponse,
    ProjectTrackerConfigUpdate,
)
from tripl.services.project_lookup import get_project_by_slug

DEFAULT_ENABLED = False
DEFAULT_TRACKER_TYPE = "jira"
DEFAULT_ISSUE_TYPE = "Task"

# Jira scalar fields validated on update when a non-null value is supplied. The
# validators normalize (strip trailing slash, uppercase the key, ...) and raise
# ValueError on bad input, which we surface as HTTP 422. ``api_token`` is handled
# separately because it is encrypted at rest and never echoed back.
_JIRA_FIELD_VALIDATORS: dict[str, Callable[[str | None], str]] = {
    "base_url": validate_jira_base_url,
    "auth_email": validate_jira_auth_email,
    "project_key": validate_jira_project_key,
    "issue_type": validate_jira_issue_type,
}


def _to_response(config: ProjectTrackerConfig) -> ProjectTrackerConfigResponse:
    """Explicit build — ``api_token_set`` is derived, so ``model_validate`` from
    the ORM row would miss it (and we must never surface the token itself)."""
    return ProjectTrackerConfigResponse(
        id=config.id,
        project_id=config.project_id,
        enabled=config.enabled,
        tracker_type=config.tracker_type,
        base_url=config.base_url,
        project_key=config.project_key,
        auth_email=config.auth_email,
        issue_type=config.issue_type,
        api_token_set=bool(config.api_token_encrypted),
        created_at=config.created_at,
        updated_at=config.updated_at,
    )


def _defaults_response(project_id: uuid.UUID) -> ProjectTrackerConfigResponse:
    return ProjectTrackerConfigResponse(
        project_id=project_id,
        enabled=DEFAULT_ENABLED,
        tracker_type=DEFAULT_TRACKER_TYPE,
        base_url="",
        project_key="",
        auth_email="",
        issue_type=DEFAULT_ISSUE_TYPE,
        api_token_set=False,
    )


async def _ensure_config(
    session: AsyncSession,
    project_id: uuid.UUID,
) -> ProjectTrackerConfig:
    config = await session.scalar(
        select(ProjectTrackerConfig).where(ProjectTrackerConfig.project_id == project_id)
    )
    if config is not None:
        return config

    config = ProjectTrackerConfig(project_id=project_id)
    session.add(config)
    try:
        await session.commit()
    except IntegrityError:
        # Lost a concurrent first-write race on uq_project_tracker_config_project;
        # the winner's row is what we want.
        await session.rollback()
        winner: ProjectTrackerConfig | None = await session.scalar(
            select(ProjectTrackerConfig).where(ProjectTrackerConfig.project_id == project_id)
        )
        if winner is None:  # pragma: no cover — row vanished between commit and re-read
            raise
        return winner
    await session.refresh(config)
    return config


async def get_project_tracker_config(
    session: AsyncSession,
    slug: str,
) -> ProjectTrackerConfigResponse:
    """Read-only: projects that never configured a tracker get the defaults back
    without a row being written (GETs must not mutate the database)."""
    project = await get_project_by_slug(session, slug)
    config = await session.scalar(
        select(ProjectTrackerConfig).where(ProjectTrackerConfig.project_id == project.id)
    )
    if config is None:
        return _defaults_response(project.id)
    return _to_response(config)


async def update_project_tracker_config(
    session: AsyncSession,
    slug: str,
    data: ProjectTrackerConfigUpdate,
) -> ProjectTrackerConfigResponse:
    project = await get_project_by_slug(session, slug)
    config = await _ensure_config(session, project.id)
    payload = data.model_dump(exclude_unset=True)

    # api_token is encrypted at rest and never stored raw. ""/clears the token;
    # None/omitted leaves it unchanged; a real value is validated then encrypted.
    if "api_token" in payload:
        raw_token = payload.pop("api_token")
        if raw_token is not None:
            if raw_token == "":
                config.api_token_encrypted = ""
            else:
                config.api_token_encrypted = encrypt_value(
                    _validate(validate_jira_api_token, raw_token)
                )

    for key, value in payload.items():
        if value is None:
            # An explicit JSON null is not a valid value for a NOT NULL column —
            # treat it the same as omitting the field.
            continue
        validator = _JIRA_FIELD_VALIDATORS.get(key)
        if validator is not None:
            value = _validate(validator, value)
        setattr(config, key, value)

    await session.commit()
    await session.refresh(config)
    return _to_response(config)


def _validate(validator: Callable[[str | None], str], value: str) -> str:
    try:
        return validator(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
