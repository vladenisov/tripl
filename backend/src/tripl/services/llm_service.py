from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, cast

from tripl.config import settings  # noqa: F401 - kept for test monkeypatching
from tripl.services.app_settings_service import AiConfig, env_ai_config

logger = logging.getLogger(__name__)

_MAX_USER_PROMPT_CHARS = 24_000
_MAX_PARAM_RETRIES = 3


def is_enabled(config: AiConfig | None = None) -> bool:
    cfg = config if config is not None else env_ai_config()
    return cfg.ai_enabled and bool(cfg.ai_api_key)


def _post_chat_completions(
    url: str, payload: dict[str, Any], api_key: str, timeout: float
) -> tuple[str | None, dict[str, Any] | None]:
    """POST the payload; return (response_body, None) or (None, provider_error).

    provider_error is the parsed ``error`` object from an HTTP 4xx/5xx response
    (empty dict when the body is missing or not JSON). Network-level failures
    return (None, None) after logging.
    """
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            return response.read().decode("utf-8"), None
    except urllib.error.HTTPError as exc:
        try:
            error_body = exc.read().decode("utf-8", errors="replace")[:2000]
        except OSError:
            error_body = "<unreadable>"
        logger.warning(
            "AI completion request failed with HTTP %s: %s; model=%s url=%s body=%s",
            exc.code,
            exc.reason,
            payload.get("model"),
            url,
            error_body,
        )
        error: dict[str, Any] = {}
        try:
            parsed = json.loads(error_body)
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
                error = parsed["error"]
        except json.JSONDecodeError:
            pass
        return None, error
    except (urllib.error.URLError, TimeoutError):
        logger.exception("AI completion request failed")
        return None, None


def _adjust_payload_for_error(payload: dict[str, Any], error: dict[str, Any]) -> bool:
    """Mutate payload to work around an unsupported-parameter error.

    Newer OpenAI models (gpt-5.x, o-series) reject ``max_tokens`` in favor of
    ``max_completion_tokens`` and only allow the default ``temperature``.
    Returns True when the payload changed and the request is worth retrying.
    """
    if error.get("code") not in {"unsupported_parameter", "unsupported_value"}:
        return False
    param = error.get("param")
    if param == "max_tokens" and "max_tokens" in payload:
        payload["max_completion_tokens"] = payload.pop("max_tokens")
        return True
    if param == "temperature" and "temperature" in payload:
        del payload["temperature"]
        return True
    return False


def complete(
    system_prompt: str,
    user_prompt: str,
    *,
    max_tokens: int | None = None,
    temperature: float = 0.2,
    config: AiConfig | None = None,
) -> str | None:
    cfg = config if config is not None else env_ai_config()
    if not is_enabled(cfg):
        return None
    api_key = cfg.ai_api_key
    if not api_key:
        logger.warning("AI features enabled but no API key is configured")
        return None

    truncated_user_prompt = user_prompt[:_MAX_USER_PROMPT_CHARS]
    payload: dict[str, Any] = {
        "model": cfg.ai_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": truncated_user_prompt},
        ],
        "max_tokens": max_tokens if max_tokens is not None else cfg.ai_max_output_tokens,
        "temperature": temperature,
    }

    url = cfg.ai_base_url.rstrip("/") + "/chat/completions"
    body: str | None = None
    for _ in range(_MAX_PARAM_RETRIES):
        body, error = _post_chat_completions(url, payload, api_key, cfg.ai_timeout_seconds)
        if body is not None:
            break
        if error is None or not _adjust_payload_for_error(payload, error):
            return None
        logger.info("Retrying AI completion with adjusted parameters: %s", error.get("param"))
    if body is None:
        return None

    try:
        parsed = cast(dict[str, Any], json.loads(body))
        choices = parsed.get("choices")
        if not isinstance(choices, list) or not choices:
            logger.warning("AI completion response has no choices")
            return None
        message = choices[0].get("message", {})
        content = message.get("content")
        if not isinstance(content, str):
            logger.warning("AI completion response content is not a string")
            return None
        return content
    except (json.JSONDecodeError, KeyError, IndexError):
        logger.exception("Failed to parse AI completion response")
        return None
