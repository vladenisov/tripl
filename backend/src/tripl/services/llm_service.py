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


def is_enabled(config: AiConfig | None = None) -> bool:
    cfg = config if config is not None else env_ai_config()
    return cfg.ai_enabled and bool(cfg.ai_api_key)


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
        with urllib.request.urlopen(request, timeout=cfg.ai_timeout_seconds) as response:  # noqa: S310
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        try:
            error_body = exc.read().decode("utf-8", errors="replace")[:2000]
        except OSError:
            error_body = "<unreadable>"
        logger.warning(
            "AI completion request failed with HTTP %s: %s; model=%s url=%s body=%s",
            exc.code,
            exc.reason,
            cfg.ai_model,
            url,
            error_body,
        )
        return None
    except (urllib.error.URLError, TimeoutError):
        logger.exception("AI completion request failed")
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
