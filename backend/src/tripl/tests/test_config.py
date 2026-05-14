from __future__ import annotations

import pytest

from tripl.config import Settings


def test_cors_origins_explicit_list_wins() -> None:
    s = Settings(cors_allow_origins="https://a.example, https://b.example", debug=False)
    assert s.cors_origins() == ["https://a.example", "https://b.example"]


def test_cors_origins_debug_default_is_wildcard() -> None:
    s = Settings(cors_allow_origins="", debug=True, app_base_url="")
    assert s.cors_origins() == ["*"]


def test_cors_origins_production_falls_back_to_app_base_url() -> None:
    s = Settings(
        cors_allow_origins="",
        debug=False,
        app_base_url="https://app.example.com/",
    )
    # Trailing slash is trimmed so the value matches the browser's Origin header.
    assert s.cors_origins() == ["https://app.example.com"]


def test_cors_origins_production_with_no_origin_is_empty() -> None:
    s = Settings(cors_allow_origins="", debug=False, app_base_url="")
    assert s.cors_origins() == []


def test_assert_production_ready_skipped_in_debug() -> None:
    Settings(debug=True, encryption_key="").assert_production_ready()


def test_assert_production_ready_requires_encryption_key() -> None:
    s = Settings(
        debug=False,
        encryption_key="",
        session_cookie_secure=True,
        cors_allow_origins="https://a.example",
    )
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "ENCRYPTION_KEY" in str(exc.value)


def test_assert_production_ready_rejects_invalid_encryption_key() -> None:
    s = Settings(
        debug=False,
        encryption_key="not-a-real-fernet-key",
        session_cookie_secure=True,
        cors_allow_origins="https://a.example",
    )
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "Fernet" in str(exc.value)


def test_assert_production_ready_passes_with_valid_setup() -> None:
    from cryptography.fernet import Fernet

    s = Settings(
        debug=False,
        encryption_key=Fernet.generate_key().decode(),
        session_cookie_secure=True,
        cors_allow_origins="https://app.example",
    )
    s.assert_production_ready()


def test_assert_production_ready_requires_cors_origin() -> None:
    from cryptography.fernet import Fernet

    s = Settings(
        debug=False,
        encryption_key=Fernet.generate_key().decode(),
        session_cookie_secure=True,
        cors_allow_origins="",
        app_base_url="",
    )
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "CORS" in str(exc.value)


def test_assert_production_ready_requires_secure_cookies() -> None:
    from cryptography.fernet import Fernet

    s = Settings(
        debug=False,
        encryption_key=Fernet.generate_key().decode(),
        session_cookie_secure=False,
        cors_allow_origins="https://app.example",
    )
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "SESSION_COOKIE_SECURE" in str(exc.value)
