from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException
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


def test_startup_ignores_an_override_that_would_prevent_boot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stored setting must never be the reason the process cannot start.

    session_cookie_secure is applied at startup and assert_production_ready
    refuses a non-debug boot without it, so unticking "Secure cookie" in the
    admin UI used to brick the instance on the next restart — with the only
    recovery being hand-edited SQL, because the UI lives in the process that no
    longer starts (tripl-jfm3.93).
    """
    monkeypatch.setattr(
        app_settings_service,
        "get_service_overrides_sync",
        lambda _session: {"session_cookie_secure": False, "hsts_enabled": True},
    )
    monkeypatch.setattr(settings, "debug", False)
    monkeypatch.setattr(settings, "session_cookie_secure", True)
    monkeypatch.setattr(settings, "hsts_enabled", False)

    applied = app_settings_service.apply_startup_service_overrides(session=object())  # type: ignore[arg-type]

    # Nothing is applied, and — the point of the fix — the env value survives so
    # the app boots and the operator can undo the change where they made it.
    assert applied == []
    assert settings.session_cookie_secure is True
    assert settings.hsts_enabled is False


def test_saving_an_override_that_would_prevent_boot_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Dropping it silently at boot is safe but dishonest — say so at save time."""
    monkeypatch.setattr(settings, "debug", False)
    # The env must be healthy on this axis, or the override introduces nothing new.
    monkeypatch.setattr(settings, "session_cookie_secure", True)

    with pytest.raises(HTTPException) as excinfo:
        app_settings_service._reject_startup_breaking_overrides({"session_cookie_secure": False})

    assert excinfo.value.status_code == 422
    assert "stop the app from starting" in str(excinfo.value.detail)

    # A harmless override still passes.
    app_settings_service._reject_startup_breaking_overrides({"hsts_enabled": True})


def test_saving_is_not_blocked_by_problems_the_environment_already_has(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only what THIS change breaks.

    A deployment already missing SECRET_KEY must not have every unrelated
    settings save rejected on top of it — the check diffs against the current
    settings rather than judging the candidate in isolation.
    """
    monkeypatch.setattr(settings, "debug", False)
    monkeypatch.setattr(settings, "secret_key", "")

    app_settings_service._reject_startup_breaking_overrides({"hsts_enabled": True})


def test_registration_mode_is_resolved_live_not_at_startup() -> None:
    """Closing registration must not wait for a redeploy (tripl-jfm3.9).

    Every other security override is pinned onto ``settings`` at process start;
    ``registration_mode`` is deliberately excluded and read per request instead.
    """
    assert "registration_mode" in app_settings_service.SECURITY_FIELDS
    assert "registration_mode" not in app_settings_service.STARTUP_APPLIED_FIELDS
    # The rest of the security section is still startup-applied.
    assert "hsts_enabled" in app_settings_service.STARTUP_APPLIED_FIELDS


@pytest.mark.asyncio
async def test_registration_mode_override_wins_over_env(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "registration_mode", "open")

    async with TestSessionLocal() as session:
        assert await app_settings_service.get_registration_mode(session) == "open"

    resp = await client.patch(
        "/api/v1/settings", json={"security": {"registration_mode": "disabled"}}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["sources"]["security.registration_mode"] == "override"

    async with TestSessionLocal() as session:
        assert await app_settings_service.get_registration_mode(session) == "disabled"

    # Clearing the override falls back to the env value.
    cleared = await client.patch("/api/v1/settings", json={"security": {"registration_mode": None}})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["sources"]["security.registration_mode"] == "env"
    async with TestSessionLocal() as session:
        assert await app_settings_service.get_registration_mode(session) == "open"
