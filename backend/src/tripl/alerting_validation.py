from __future__ import annotations

import re
from urllib.parse import urlparse

_TELEGRAM_BOT_TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]+$")
_TELEGRAM_CHAT_ID_RE = re.compile(r"^(?:-?\d+|@[A-Za-z0-9_]+)$")
_ALLOWED_SLACK_HOSTS = {"hooks.slack.com", "hooks.slack-gov.com"}
# RFC 7230 header field-name token characters.
_HTTP_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")


def normalize_required_text(value: str, *, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} is required")
    return normalized


def normalize_optional_secret(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _has_disallowed_characters(value: str) -> bool:
    return any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value)


def validate_slack_webhook_url(value: str | None) -> str:
    if value is None:
        raise ValueError("Slack webhook_url is required")
    normalized = normalize_required_text(value, field_name="Slack webhook_url")
    if _has_disallowed_characters(normalized):
        raise ValueError("Slack webhook_url must not contain whitespace or control characters")

    parsed = urlparse(normalized)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("Slack webhook_url must be a valid https URL")
    if parsed.hostname not in _ALLOWED_SLACK_HOSTS:
        raise ValueError("Slack webhook_url must point to hooks.slack.com")
    return normalized


def validate_telegram_bot_token(value: str | None) -> str:
    if value is None:
        raise ValueError("Telegram bot_token is required")
    normalized = normalize_required_text(value, field_name="Telegram bot_token")
    if _has_disallowed_characters(normalized):
        raise ValueError("Telegram bot_token must not contain whitespace or control characters")
    if not _TELEGRAM_BOT_TOKEN_RE.fullmatch(normalized):
        raise ValueError("Telegram bot_token must match <digits>:<token>")
    return normalized


def validate_telegram_chat_id(value: str | None) -> str:
    if value is None:
        raise ValueError("Telegram chat_id is required")
    normalized = normalize_required_text(value, field_name="Telegram chat_id")
    if _has_disallowed_characters(normalized):
        raise ValueError("Telegram chat_id must not contain whitespace or control characters")
    if not _TELEGRAM_CHAT_ID_RE.fullmatch(normalized):
        raise ValueError("Telegram chat_id must be a numeric chat id or @channel")
    return normalized


def validate_webhook_target_url(value: str | None) -> str:
    if value is None:
        raise ValueError("Webhook target_url is required")
    normalized = normalize_required_text(value, field_name="Webhook target_url")
    if _has_disallowed_characters(normalized):
        raise ValueError("Webhook target_url must not contain whitespace or control characters")

    parsed = urlparse(normalized)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("Webhook target_url must be a valid https URL")
    return normalized


def validate_webhook_header_name(value: str | None) -> str | None:
    normalized = normalize_optional_secret(value)
    if normalized is None:
        return None
    if not _HTTP_HEADER_NAME_RE.fullmatch(normalized):
        raise ValueError("Webhook header name must be a valid HTTP header token")
    return normalized


def validate_webhook_header_value(value: str | None) -> str | None:
    if value is None:
        return None
    # Header values may contain spaces (e.g. "Bearer xyz") but never CR/LF or
    # other control characters — those enable header injection.
    if any((ord(char) < 32 and char != "\t") or ord(char) == 127 for char in value):
        raise ValueError("Webhook header value must not contain control characters")
    normalized = value.strip()
    return normalized or None
