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


def test_debug_accepts_release_env_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEBUG", "release")
    assert Settings().debug is False


def test_debug_accepts_development_alias() -> None:
    assert Settings(debug="development").debug is True


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


def _valid_production_settings(**overrides: object) -> Settings:
    """A Settings instance that passes assert_production_ready, with explicit
    non-default DB/queue URLs so the dev-credential guard doesn't trip. Tests
    override one field at a time to isolate a single failure."""
    from cryptography.fernet import Fernet

    base: dict[str, object] = {
        "debug": False,
        "encryption_key": Fernet.generate_key().decode(),
        "secret_key": "x" * 32,
        "session_cookie_secure": True,
        "cors_allow_origins": "https://app.example",
        "database_url": "postgresql+asyncpg://produser:prodpw@db:5432/tripl",
        "sync_database_url": "postgresql+psycopg://produser:prodpw@db:5432/tripl",
        "rabbitmq_url": "amqp://produser:prodpw@mq:5672//",
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


def test_assert_production_ready_passes_with_valid_setup() -> None:
    _valid_production_settings().assert_production_ready()


def test_assert_production_ready_requires_secret_key() -> None:
    s = _valid_production_settings(secret_key="")
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "SECRET_KEY" in str(exc.value)


def test_assert_production_ready_rejects_default_database_credentials() -> None:
    s = _valid_production_settings(
        database_url="postgresql+asyncpg://tripl:tripl@localhost:5432/tripl",
    )
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "DATABASE_URL" in str(exc.value)


def test_assert_production_ready_rejects_default_sync_database_credentials() -> None:
    s = _valid_production_settings(
        sync_database_url="postgresql+psycopg://tripl:tripl@localhost:5432/tripl",
    )
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "SYNC_DATABASE_URL" in str(exc.value)


def test_assert_production_ready_rejects_default_rabbitmq_credentials() -> None:
    s = _valid_production_settings(rabbitmq_url="amqp://guest:guest@localhost:5672//")
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "RABBITMQ_URL" in str(exc.value)


def test_assert_production_ready_rejects_wildcard_cors() -> None:
    # An explicit "*" in the CORS list resolves to the wildcard, which breaks
    # cookie auth in browsers.
    s = _valid_production_settings(cors_allow_origins="*")
    with pytest.raises(RuntimeError) as exc:
        s.assert_production_ready()
    assert "wildcard" in str(exc.value).lower()


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
