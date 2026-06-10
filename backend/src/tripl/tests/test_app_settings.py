from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy import select

from tripl import crypto
from tripl.config import settings
from tripl.models.app_setting import SERVICE_SETTINGS_KEY, AppSetting
from tripl.services import app_settings_service
from tripl.tests.conftest import TestSessionLocal


@pytest.mark.asyncio
async def test_service_settings_update_uses_env_fallback_and_encrypts_secrets(
    client: AsyncClient,
) -> None:
    original_key = settings.encryption_key
    settings.encryption_key = Fernet.generate_key().decode()
    crypto._fernet.cache_clear()
    try:
        await client.post("/api/v1/projects", json={"name": "AI", "slug": "settings-ai"})

        initial = await client.get("/api/v1/settings")
        assert initial.status_code == 200
        assert initial.json()["sources"]["ai.ai_enabled"] == "env"
        assert "runtime" in initial.json()
        assert "security" in initial.json()
        assert "storage" in initial.json()
        assert "observability" in initial.json()
        assert "email" in initial.json()
        assert "system" in initial.json()

        resp = await client.patch(
            "/api/v1/settings",
            json={
                "runtime": {
                    "app_base_url": "https://tripl.example",
                    "scan_row_limit_default": 123,
                },
                "ai": {
                    "ai_enabled": True,
                    "ai_api_key": "sk-runtime",
                    "describe_system_prompt": "Return JSON only.",
                },
                "email": {"smtp_password": "smtp-secret"},
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["runtime"]["app_base_url"] == "https://tripl.example"
        assert body["runtime"]["scan_row_limit_default"] == 123
        assert body["ai"]["ai_api_key_configured"] is True
        assert body["email"]["smtp_password_configured"] is True
        assert body["sources"]["runtime.app_base_url"] == "override"
        assert body["sources"]["ai.ai_api_key"] == "override"
        assert "sk-runtime" not in str(body)
        assert "smtp-secret" not in str(body)

        status = await client.get("/api/v1/projects/settings-ai/ai/status")
        assert status.json() == {"enabled": True}

        async with TestSessionLocal() as session:
            row = await session.scalar(
                select(AppSetting).where(AppSetting.key == SERVICE_SETTINGS_KEY)
            )
            assert row is not None
            assert row.value["ai_api_key"] != "sk-runtime"
            assert row.value["smtp_password"] != "smtp-secret"
            ai_config = await app_settings_service.get_ai_config(session)
            assert ai_config.ai_api_key == "sk-runtime"
            assert ai_config.describe_system_prompt == "Return JSON only."
    finally:
        settings.encryption_key = original_key
        crypto._fernet.cache_clear()


@pytest.mark.asyncio
async def test_service_settings_are_owner_only(anon_client: AsyncClient) -> None:
    owner = await anon_client.post(
        "/api/v1/auth/register",
        json={
            "email": "owner@example.com",
            "password": "Password123!",
            "name": "Owner",
        },
    )
    assert owner.status_code == 201
    await anon_client.post("/api/v1/auth/logout")

    editor = await anon_client.post(
        "/api/v1/auth/register",
        json={
            "email": "editor@example.com",
            "password": "Password123!",
            "name": "Editor",
        },
    )
    assert editor.status_code == 201
    assert editor.json()["role"] == "editor"

    resp = await anon_client.get("/api/v1/settings")
    assert resp.status_code == 403
