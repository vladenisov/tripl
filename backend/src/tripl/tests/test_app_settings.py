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


def test_apply_startup_service_overrides_mutates_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # One field from each of the three sections that are dead until applied at
    # startup, plus an AI field that must be ignored (AI is consumed via its own
    # resolved config, not off `settings`).
    overrides = {
        "hsts_enabled": True,  # security
        "photo_max_size_mb": 99,  # storage
        "log_level": "DEBUG",  # observability
        "ai_model": "should-not-be-applied",  # not a startup-applied field
    }
    monkeypatch.setattr(
        app_settings_service, "get_service_overrides_sync", lambda _session: overrides
    )

    touched = ("hsts_enabled", "photo_max_size_mb", "log_level", "ai_model")
    originals = {f: getattr(settings, f) for f in touched}
    try:
        applied = app_settings_service.apply_startup_service_overrides(session=object())  # type: ignore[arg-type]

        assert set(applied) == {"hsts_enabled", "photo_max_size_mb", "log_level"}
        assert settings.hsts_enabled is True
        assert settings.photo_max_size_mb == 99
        assert settings.log_level == "DEBUG"
        # AI fields are not applied onto settings by the startup hook.
        assert settings.ai_model == originals["ai_model"]
    finally:
        for field, value in originals.items():
            setattr(settings, field, value)


def test_apply_startup_service_overrides_is_noop_on_db_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _boom(_session: object) -> dict[str, object]:
        raise RuntimeError("db down")

    monkeypatch.setattr(app_settings_service, "get_service_overrides_sync", _boom)

    # Must swallow the error and apply nothing, so importing the app never fails
    # just because overrides can't be read.
    assert app_settings_service.apply_startup_service_overrides(session=object()) == []  # type: ignore[arg-type]
