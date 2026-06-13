from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter

from tripl.api.deps import OwnerUserDep, SessionDep
from tripl.schemas.app_settings import (
    AiSettingsResponse,
    AiSettingsTestRequest,
    AiSettingsUpdate,
    ServiceSettingsResponse,
    ServiceSettingsUpdate,
    SettingsTestResponse,
)
from tripl.services import app_settings_service, llm_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


def _flatten_update(payload: ServiceSettingsUpdate) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    data = payload.model_dump(exclude_unset=True)
    for section_value in data.values():
        if isinstance(section_value, dict):
            changes.update(section_value)
    return changes


def _ai_response(payload: dict[str, Any]) -> AiSettingsResponse:
    ai_fields = set(app_settings_service.AI_FIELDS)
    return AiSettingsResponse(
        ai=payload["ai"],
        overridden_fields=[field for field in payload["overridden_fields"] if field in ai_fields],
        sources={key: value for key, value in payload["sources"].items() if key.startswith("ai.")},
    )


@router.get("", response_model=ServiceSettingsResponse)
async def get_service_settings(
    session: SessionDep,
    _current_user: OwnerUserDep,
) -> ServiceSettingsResponse:
    return ServiceSettingsResponse.model_validate(
        await app_settings_service.get_service_settings(session)
    )


@router.patch("", response_model=ServiceSettingsResponse)
async def patch_service_settings(
    session: SessionDep,
    _current_user: OwnerUserDep,
    payload: ServiceSettingsUpdate,
) -> ServiceSettingsResponse:
    settings_payload = app_settings_service.public_service_settings(
        await app_settings_service.update_service_overrides(session, _flatten_update(payload))
    )
    return ServiceSettingsResponse.model_validate(settings_payload)


@router.put("", response_model=ServiceSettingsResponse)
async def put_service_settings(
    session: SessionDep,
    _current_user: OwnerUserDep,
    payload: ServiceSettingsUpdate,
) -> ServiceSettingsResponse:
    return await patch_service_settings(session, _current_user, payload)


@router.get("/ai", response_model=AiSettingsResponse)
async def get_ai_settings(
    session: SessionDep,
    _current_user: OwnerUserDep,
) -> AiSettingsResponse:
    return _ai_response(await app_settings_service.get_service_settings(session))


@router.put("/ai", response_model=AiSettingsResponse)
async def put_ai_settings(
    session: SessionDep,
    _current_user: OwnerUserDep,
    payload: AiSettingsUpdate,
) -> AiSettingsResponse:
    changes = payload.model_dump(exclude_unset=True)
    settings_payload = app_settings_service.public_service_settings(
        await app_settings_service.update_ai_overrides(session, changes)
    )
    return _ai_response(settings_payload)


@router.post("/ai/test", response_model=SettingsTestResponse)
async def test_ai_settings(
    session: SessionDep,
    _current_user: OwnerUserDep,
    payload: AiSettingsTestRequest,
) -> SettingsTestResponse:
    config = await app_settings_service.get_ai_config(session)
    if not llm_service.is_enabled(config):
        return SettingsTestResponse(
            ok=False,
            message="AI is disabled or no API key is configured.",
        )
    try:
        raw = await asyncio.to_thread(
            llm_service.complete,
            "You are a connection test endpoint. Keep the response short.",
            payload.prompt,
            max_tokens=20,
            temperature=0,
            config=config,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI settings test failed", exc_info=True)
        return SettingsTestResponse(ok=False, message=str(exc))
    message = (raw or "").strip()
    return SettingsTestResponse(ok=bool(message), message=message or "No response from provider.")
