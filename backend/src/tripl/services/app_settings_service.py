"""Service-wide runtime settings stored in the ``app_settings`` table.

The ``service`` document stores only explicit overrides for env-based defaults
from :class:`tripl.config.Settings`. Resolution order per field is:
DB override -> env. Secret overrides are encrypted at rest and never returned
to clients; clients only see ``*_configured`` booleans.

Both async (API) and sync (Celery worker) accessors are provided. Sync accessors
degrade to env-only configuration on DB errors so background jobs never fail
just because runtime settings cannot be read.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, fields
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from tripl import crypto
from tripl.config import settings
from tripl.models.app_setting import AI_SETTINGS_KEY, SERVICE_SETTINGS_KEY, AppSetting
from tripl.services.ai_defaults import (
    DEFAULT_ALERT_EXPLANATION_SYSTEM_PROMPT,
    DEFAULT_ASK_SYSTEM_PROMPT,
    DEFAULT_DESCRIBE_SYSTEM_PROMPT,
)

logger = logging.getLogger(__name__)

SettingSource = Literal["env", "override"]

RUNTIME_FIELDS = (
    "app_base_url",
    "scan_row_limit_default",
    "metrics_row_limit_default",
)
SECURITY_FIELDS = (
    "cors_allow_origins",
    "session_cookie_name",
    "session_ttl_hours",
    "session_cookie_secure",
    "security_headers_enabled",
    "hsts_enabled",
    "hsts_max_age_seconds",
    "content_security_policy",
    "rate_limit_enabled",
    "rate_limit_login_per_minute",
    "rate_limit_register_per_hour",
    "rate_limit_trust_forwarded_for",
)
STORAGE_FIELDS = (
    "photo_storage_backend",
    "photo_local_dir",
    "photo_max_size_mb",
    "photo_allowed_mime",
    "gcs_photo_bucket",
    "gcs_photo_credentials_path",
    "gcs_photo_public",
    "gcs_photo_signed_url_ttl_seconds",
)
OBSERVABILITY_FIELDS = (
    "request_id_header",
    "log_level",
    "log_json",
    "prometheus_metrics_enabled",
    "otel_exporter_otlp_endpoint",
    "otel_service_name",
)
EMAIL_FIELDS = (
    "smtp_host",
    "smtp_port",
    "smtp_username",
    "smtp_password",
    "smtp_use_tls",
    "smtp_from_address",
)
AI_FIELDS = (
    "ai_enabled",
    "ai_base_url",
    "ai_model",
    "ai_api_key",
    "ai_timeout_seconds",
    "ai_max_output_tokens",
    "describe_system_prompt",
    "ask_system_prompt",
    "alert_explanation_system_prompt",
    "search_embeddings_enabled",
    "search_embedding_provider",
    "search_embedding_model",
    "search_embedding_api_key",
)

FIELD_SECTIONS: dict[str, tuple[str, ...]] = {
    "runtime": RUNTIME_FIELDS,
    "security": SECURITY_FIELDS,
    "storage": STORAGE_FIELDS,
    "observability": OBSERVABILITY_FIELDS,
    "email": EMAIL_FIELDS,
    "ai": AI_FIELDS,
}
EDITABLE_FIELDS = frozenset(
    field for section_fields in FIELD_SECTIONS.values() for field in section_fields
)
SECRET_FIELDS = frozenset({"ai_api_key", "search_embedding_api_key", "smtp_password"})
AI_SECRET_FIELDS = frozenset({"ai_api_key", "search_embedding_api_key"})


@dataclass(frozen=True)
class RuntimeConfig:
    app_base_url: str
    scan_row_limit_default: int
    metrics_row_limit_default: int


@dataclass(frozen=True)
class EmailConfig:
    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_password: str
    smtp_use_tls: bool
    smtp_from_address: str


@dataclass(frozen=True)
class AiConfig:
    """Effective AI configuration used by LLM and embedding callers.

    API keys are already resolved (field-specific override -> field-specific
    env -> ``OPENAI_API_KEY`` env fallback) and decrypted.
    """

    ai_enabled: bool
    ai_base_url: str
    ai_model: str
    ai_api_key: str
    ai_timeout_seconds: int
    ai_max_output_tokens: int
    describe_system_prompt: str
    ask_system_prompt: str
    alert_explanation_system_prompt: str
    search_embeddings_enabled: bool
    search_embedding_provider: str
    search_embedding_model: str
    search_embedding_api_key: str


AI_CONFIG_FIELDS = frozenset(f.name for f in fields(AiConfig))


def default_ai_prompts() -> dict[str, str]:
    return {
        "describe_system_prompt": DEFAULT_DESCRIBE_SYSTEM_PROMPT,
        "ask_system_prompt": DEFAULT_ASK_SYSTEM_PROMPT,
        "alert_explanation_system_prompt": DEFAULT_ALERT_EXPLANATION_SYSTEM_PROMPT,
    }


def env_service_values() -> dict[str, Any]:
    """Every editable service setting from env/default settings only."""
    return {
        "app_base_url": settings.app_base_url,
        "scan_row_limit_default": settings.scan_row_limit_default,
        "metrics_row_limit_default": settings.metrics_row_limit_default,
        "cors_allow_origins": settings.cors_allow_origins,
        "session_cookie_name": settings.session_cookie_name,
        "session_ttl_hours": settings.session_ttl_hours,
        "session_cookie_secure": settings.session_cookie_secure,
        "security_headers_enabled": settings.security_headers_enabled,
        "hsts_enabled": settings.hsts_enabled,
        "hsts_max_age_seconds": settings.hsts_max_age_seconds,
        "content_security_policy": settings.content_security_policy,
        "rate_limit_enabled": settings.rate_limit_enabled,
        "rate_limit_login_per_minute": settings.rate_limit_login_per_minute,
        "rate_limit_register_per_hour": settings.rate_limit_register_per_hour,
        "rate_limit_trust_forwarded_for": settings.rate_limit_trust_forwarded_for,
        "photo_storage_backend": settings.photo_storage_backend,
        "photo_local_dir": settings.photo_local_dir,
        "photo_max_size_mb": settings.photo_max_size_mb,
        "photo_allowed_mime": settings.photo_allowed_mime,
        "gcs_photo_bucket": settings.gcs_photo_bucket,
        "gcs_photo_credentials_path": settings.gcs_photo_credentials_path,
        "gcs_photo_public": settings.gcs_photo_public,
        "gcs_photo_signed_url_ttl_seconds": settings.gcs_photo_signed_url_ttl_seconds,
        "request_id_header": settings.request_id_header,
        "log_level": settings.log_level,
        "log_json": settings.log_json,
        "prometheus_metrics_enabled": settings.prometheus_metrics_enabled,
        "otel_exporter_otlp_endpoint": settings.otel_exporter_otlp_endpoint,
        "otel_service_name": settings.otel_service_name,
        "smtp_host": settings.smtp_host,
        "smtp_port": settings.smtp_port,
        "smtp_username": settings.smtp_username,
        "smtp_password": settings.smtp_password,
        "smtp_use_tls": settings.smtp_use_tls,
        "smtp_from_address": settings.smtp_from_address,
        "ai_enabled": settings.ai_enabled,
        "ai_base_url": settings.ai_base_url,
        "ai_model": settings.ai_model,
        "ai_api_key": settings.resolved_ai_api_key(),
        "ai_timeout_seconds": settings.ai_timeout_seconds,
        "ai_max_output_tokens": settings.ai_max_output_tokens,
        "describe_system_prompt": DEFAULT_DESCRIBE_SYSTEM_PROMPT,
        "ask_system_prompt": DEFAULT_ASK_SYSTEM_PROMPT,
        "alert_explanation_system_prompt": DEFAULT_ALERT_EXPLANATION_SYSTEM_PROMPT,
        "search_embeddings_enabled": settings.search_embeddings_enabled,
        "search_embedding_provider": settings.search_embedding_provider,
        "search_embedding_model": settings.search_embedding_model,
        "search_embedding_api_key": settings.resolved_search_embedding_api_key(),
    }


def env_ai_config() -> AiConfig:
    return build_ai_config({})


def env_email_config() -> EmailConfig:
    return build_email_config({})


def env_runtime_config() -> RuntimeConfig:
    return build_runtime_config({})


def _decrypt_override(key: str, value: Any) -> str | None:
    try:
        return crypto.decrypt_value(str(value))
    except crypto.InvalidToken:
        logger.warning("Cannot decrypt stored %s override; using env value", key)
        return None


def build_service_values(overrides: dict[str, Any]) -> dict[str, Any]:
    values = env_service_values()
    for key, value in overrides.items():
        if key not in EDITABLE_FIELDS or value is None:
            continue
        if key in SECRET_FIELDS:
            decrypted = _decrypt_override(key, value)
            if decrypted is not None:
                values[key] = decrypted
            continue
        values[key] = value
    return values


def build_runtime_config(overrides: dict[str, Any]) -> RuntimeConfig:
    values = build_service_values(overrides)
    return RuntimeConfig(
        app_base_url=str(values["app_base_url"]),
        scan_row_limit_default=int(values["scan_row_limit_default"]),
        metrics_row_limit_default=int(values["metrics_row_limit_default"]),
    )


def build_email_config(overrides: dict[str, Any]) -> EmailConfig:
    values = build_service_values(overrides)
    return EmailConfig(
        smtp_host=str(values["smtp_host"]),
        smtp_port=int(values["smtp_port"]),
        smtp_username=str(values["smtp_username"]),
        smtp_password=str(values["smtp_password"]),
        smtp_use_tls=bool(values["smtp_use_tls"]),
        smtp_from_address=str(values["smtp_from_address"]),
    )


def build_ai_config(overrides: dict[str, Any]) -> AiConfig:
    values = build_service_values(overrides)
    return AiConfig(
        ai_enabled=bool(values["ai_enabled"]),
        ai_base_url=str(values["ai_base_url"]),
        ai_model=str(values["ai_model"]),
        ai_api_key=str(values["ai_api_key"]),
        ai_timeout_seconds=int(values["ai_timeout_seconds"]),
        ai_max_output_tokens=int(values["ai_max_output_tokens"]),
        describe_system_prompt=str(values["describe_system_prompt"]),
        ask_system_prompt=str(values["ask_system_prompt"]),
        alert_explanation_system_prompt=str(values["alert_explanation_system_prompt"]),
        search_embeddings_enabled=bool(values["search_embeddings_enabled"]),
        search_embedding_provider=str(values["search_embedding_provider"]),
        search_embedding_model=str(values["search_embedding_model"]),
        search_embedding_api_key=str(values["search_embedding_api_key"]),
    )


async def _get_overrides_for_key(session: AsyncSession, key: str) -> dict[str, Any]:
    row = await session.scalar(select(AppSetting).where(AppSetting.key == key))
    if row is None or not isinstance(row.value, dict):
        return {}
    return dict(row.value)


def _get_overrides_for_key_sync(session: Session, key: str) -> dict[str, Any]:
    row = session.scalar(select(AppSetting).where(AppSetting.key == key))
    if row is None or not isinstance(row.value, dict):
        return {}
    return dict(row.value)


async def get_service_overrides(session: AsyncSession) -> dict[str, Any]:
    # ``ai`` is a legacy read path from the initial AI-only version. The
    # canonical ``service`` document wins when both contain a field.
    legacy_ai = await _get_overrides_for_key(session, AI_SETTINGS_KEY)
    service = await _get_overrides_for_key(session, SERVICE_SETTINGS_KEY)
    return {**legacy_ai, **service}


def get_service_overrides_sync(session: Session) -> dict[str, Any]:
    legacy_ai = _get_overrides_for_key_sync(session, AI_SETTINGS_KEY)
    service = _get_overrides_for_key_sync(session, SERVICE_SETTINGS_KEY)
    return {**legacy_ai, **service}


async def get_ai_overrides(session: AsyncSession) -> dict[str, Any]:
    return {
        key: value
        for key, value in (await get_service_overrides(session)).items()
        if key in AI_CONFIG_FIELDS
    }


def get_ai_overrides_sync(session: Session) -> dict[str, Any]:
    return {
        key: value
        for key, value in get_service_overrides_sync(session).items()
        if key in AI_CONFIG_FIELDS
    }


async def get_ai_config(session: AsyncSession) -> AiConfig:
    return build_ai_config(await get_service_overrides(session))


async def get_service_settings(session: AsyncSession) -> dict[str, Any]:
    overrides = await get_service_overrides(session)
    return public_service_settings(overrides)


def get_ai_config_sync(session: Session | None = None) -> AiConfig:
    try:
        if session is not None:
            return build_ai_config(get_service_overrides_sync(session))
        from tripl.worker.db import SyncSessionLocal

        with SyncSessionLocal() as own_session:
            return build_ai_config(get_service_overrides_sync(own_session))
    except Exception:  # noqa: BLE001
        logger.warning("Falling back to env AI config: app_settings read failed", exc_info=True)
        return env_ai_config()


def get_email_config_sync(session: Session | None = None) -> EmailConfig:
    try:
        if session is not None:
            return build_email_config(get_service_overrides_sync(session))
        from tripl.worker.db import SyncSessionLocal

        with SyncSessionLocal() as own_session:
            return build_email_config(get_service_overrides_sync(own_session))
    except Exception:  # noqa: BLE001
        logger.warning("Falling back to env email config: app_settings read failed", exc_info=True)
        return env_email_config()


def get_runtime_config_sync(session: Session | None = None) -> RuntimeConfig:
    try:
        if session is not None:
            return build_runtime_config(get_service_overrides_sync(session))
        from tripl.worker.db import SyncSessionLocal

        with SyncSessionLocal() as own_session:
            return build_runtime_config(get_service_overrides_sync(own_session))
    except Exception:  # noqa: BLE001
        logger.warning(
            "Falling back to env runtime config: app_settings read failed",
            exc_info=True,
        )
        return env_runtime_config()


async def update_service_overrides(
    session: AsyncSession,
    changes: dict[str, Any],
) -> dict[str, Any]:
    row = await session.scalar(select(AppSetting).where(AppSetting.key == SERVICE_SETTINGS_KEY))
    overrides: dict[str, Any] = (
        dict(row.value) if row is not None and isinstance(row.value, dict) else {}
    )

    for key, value in changes.items():
        if key not in EDITABLE_FIELDS:
            continue
        if value is None or (key in SECRET_FIELDS and value == ""):
            overrides.pop(key, None)
            continue
        overrides[key] = crypto.encrypt_value(str(value)) if key in SECRET_FIELDS else value

    if row is None:
        row = AppSetting(key=SERVICE_SETTINGS_KEY, value=overrides)
        session.add(row)
    else:
        row.value = overrides

    # If a partial local DB has the first-cut key="ai" row, make resets behave
    # predictably by removing touched AI fields from that legacy document.
    legacy_row = await session.scalar(select(AppSetting).where(AppSetting.key == AI_SETTINGS_KEY))
    if legacy_row is not None and isinstance(legacy_row.value, dict):
        legacy = dict(legacy_row.value)
        for key in changes:
            if key in AI_CONFIG_FIELDS:
                legacy.pop(key, None)
        legacy_row.value = legacy

    await session.commit()
    return await get_service_overrides(session)


async def update_ai_overrides(
    session: AsyncSession,
    changes: dict[str, Any],
) -> dict[str, Any]:
    ai_changes = {key: value for key, value in changes.items() if key in AI_CONFIG_FIELDS}
    return await update_service_overrides(session, ai_changes)


def public_service_settings(overrides: dict[str, Any]) -> dict[str, Any]:
    values = build_service_values(overrides)
    overridden_fields = sorted(key for key in overrides if key in EDITABLE_FIELDS)
    sources: dict[str, SettingSource] = {}
    for section, section_fields in FIELD_SECTIONS.items():
        for field in section_fields:
            sources[f"{section}.{field}"] = "override" if field in overrides else "env"

    return {
        "runtime": {
            "app_base_url": values["app_base_url"],
            "scan_row_limit_default": values["scan_row_limit_default"],
            "metrics_row_limit_default": values["metrics_row_limit_default"],
        },
        "security": {
            "cors_allow_origins": values["cors_allow_origins"],
            "session_cookie_name": values["session_cookie_name"],
            "session_ttl_hours": values["session_ttl_hours"],
            "session_cookie_secure": values["session_cookie_secure"],
            "security_headers_enabled": values["security_headers_enabled"],
            "hsts_enabled": values["hsts_enabled"],
            "hsts_max_age_seconds": values["hsts_max_age_seconds"],
            "content_security_policy": values["content_security_policy"],
            "rate_limit_enabled": values["rate_limit_enabled"],
            "rate_limit_login_per_minute": values["rate_limit_login_per_minute"],
            "rate_limit_register_per_hour": values["rate_limit_register_per_hour"],
            "rate_limit_trust_forwarded_for": values["rate_limit_trust_forwarded_for"],
        },
        "storage": {
            "photo_storage_backend": values["photo_storage_backend"],
            "photo_local_dir": values["photo_local_dir"],
            "photo_max_size_mb": values["photo_max_size_mb"],
            "photo_allowed_mime": values["photo_allowed_mime"],
            "gcs_photo_bucket": values["gcs_photo_bucket"],
            "gcs_photo_credentials_path": values["gcs_photo_credentials_path"],
            "gcs_photo_public": values["gcs_photo_public"],
            "gcs_photo_signed_url_ttl_seconds": values["gcs_photo_signed_url_ttl_seconds"],
        },
        "observability": {
            "request_id_header": values["request_id_header"],
            "log_level": values["log_level"],
            "log_json": values["log_json"],
            "prometheus_metrics_enabled": values["prometheus_metrics_enabled"],
            "otel_exporter_otlp_endpoint": values["otel_exporter_otlp_endpoint"],
            "otel_service_name": values["otel_service_name"],
        },
        "email": {
            "smtp_host": values["smtp_host"],
            "smtp_port": values["smtp_port"],
            "smtp_username": values["smtp_username"],
            "smtp_password_configured": bool(values["smtp_password"]),
            "smtp_use_tls": values["smtp_use_tls"],
            "smtp_from_address": values["smtp_from_address"],
        },
        "ai": {
            "ai_enabled": values["ai_enabled"],
            "ai_base_url": values["ai_base_url"],
            "ai_model": values["ai_model"],
            "ai_api_key_configured": bool(values["ai_api_key"]),
            "ai_timeout_seconds": values["ai_timeout_seconds"],
            "ai_max_output_tokens": values["ai_max_output_tokens"],
            "describe_system_prompt": values["describe_system_prompt"],
            "ask_system_prompt": values["ask_system_prompt"],
            "alert_explanation_system_prompt": values["alert_explanation_system_prompt"],
            "search_embeddings_enabled": values["search_embeddings_enabled"],
            "search_embedding_provider": values["search_embedding_provider"],
            "search_embedding_model": values["search_embedding_model"],
            "search_embedding_api_key_configured": bool(values["search_embedding_api_key"]),
            "search_embedding_dimensions": settings.search_embedding_dimensions,
        },
        "system": {
            "debug": settings.debug,
            "database_url_configured": bool(settings.database_url),
            "sync_database_url_configured": bool(settings.sync_database_url),
            "rabbitmq_url_configured": bool(settings.rabbitmq_url),
            "redis_url_configured": bool(settings.redis_url),
            "encryption_key_configured": bool(settings.encryption_key),
            "openai_api_key_configured": bool(settings.openai_api_key),
        },
        "overridden_fields": overridden_fields,
        "sources": sources,
    }
