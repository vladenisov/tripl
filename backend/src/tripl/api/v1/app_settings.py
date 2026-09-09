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
    EmailSettingsTestRequest,
    ServiceSettingsResponse,
    ServiceSettingsUpdate,
    SettingsTestResponse,
)
from tripl.services import _email_test_send, app_settings_service, llm_service

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
    settings_payload = await app_settings_service.service_settings_payload(
        session,
        await app_settings_service.update_service_overrides(session, _flatten_update(payload)),
    )
    return ServiceSettingsResponse.model_validate(settings_payload)


@router.put("", response_model=ServiceSettingsResponse)
async def put_service_settings(
    session: SessionDep,
    _current_user: OwnerUserDep,
    payload: ServiceSettingsUpdate,
) -> ServiceSettingsResponse:
    """Upsert service overrides. Intentionally identical to PATCH: unset fields
    are left untouched (partial update), not reset. Kept as a stable alias for
    clients that issue PUT; settings are a sparse override map with no full
    "replace all" semantics."""
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
    """Upsert AI overrides (partial: only fields present in the request body are
    applied, via exclude_unset). PUT — not PATCH — because the frontend AI
    settings form calls this endpoint; semantics are upsert, not replace-all."""
    changes = payload.model_dump(exclude_unset=True)
    settings_payload = await app_settings_service.service_settings_payload(
        session, await app_settings_service.update_ai_overrides(session, changes)
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


@router.post("/email/test", response_model=SettingsTestResponse)
async def test_email_settings(
    session: SessionDep,
    current_user: OwnerUserDep,
    payload: EmailSettingsTestRequest,
) -> SettingsTestResponse:
    """Send one probe message with the saved SMTP settings and report what happened.

    Always 200: a relay refusing us is the answer the caller asked for, not a
    server fault — the same reasoning the alert-destination test states. The
    error text is passed through verbatim because a useful SMTP diagnostic is
    the server's own words ("535 authentication failed", a connection timeout);
    smtplib carries the relay's response in there, never the credential we sent.
    """
    config = await app_settings_service.get_email_config(session)
    recipient = payload.recipient or current_user.email
    try:
        await asyncio.to_thread(
            _email_test_send.send_test_email,
            email_config=config,
            recipient=recipient,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("SMTP settings test failed", exc_info=True)
        return SettingsTestResponse(ok=False, message=str(exc))
    return SettingsTestResponse(ok=True, message=f"Test message sent to {recipient}.")
