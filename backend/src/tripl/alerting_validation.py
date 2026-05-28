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


# Pragmatic email regex: one '@', domain has at least one '.', no spaces/control
# chars. Validating to RFC 5321/6531 would be ~500 lines and still wrong for
# some edge cases — the SMTP server is the actual source of truth.
_EMAIL_ADDRESS_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_RECIPIENT_LIMIT = 50


def validate_email_address(value: str | None) -> str:
    if value is None:
        raise ValueError("Email address is required")
    normalized = normalize_required_text(value, field_name="Email address")
    if _has_disallowed_characters(normalized):
        raise ValueError("Email address must not contain whitespace or control characters")
    if not _EMAIL_ADDRESS_RE.fullmatch(normalized):
        raise ValueError("Email address must look like name@example.com")
    return normalized


def validate_email_recipients(value: str | None) -> str:
    """Parse a comma-separated recipient list and return a normalized CSV.

    Empty / whitespace-only entries are skipped. Duplicates are collapsed but
    order is preserved (first occurrence wins). Raises if no valid recipient
    remains so an empty destination can't slip through.
    """
    if value is None:
        raise ValueError("Email recipients list is required")
    seen: dict[str, None] = {}
    for raw in value.split(","):
        candidate = raw.strip()
        if not candidate:
            continue
        address = validate_email_address(candidate)
        seen.setdefault(address, None)
    if not seen:
        raise ValueError("Email recipients list must contain at least one address")
    if len(seen) > _RECIPIENT_LIMIT:
        raise ValueError(f"Email recipients list cannot exceed {_RECIPIENT_LIMIT} entries")
    return ", ".join(seen)


def validate_email_from_address(value: str | None) -> str | None:
    """Optional override — None falls back to settings.smtp_from_address."""
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    return validate_email_address(normalized)


def validate_email_subject_template(value: str | None) -> str | None:
    """Optional subject template. CR/LF would enable header injection; reject."""
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if "\n" in normalized or "\r" in normalized:
        raise ValueError("Email subject template must not contain newlines")
    if len(normalized) > 500:
        raise ValueError("Email subject template must be <= 500 characters")
    return normalized
