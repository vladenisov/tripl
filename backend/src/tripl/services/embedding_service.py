from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, cast

from tripl.config import settings
from tripl.services.app_settings_service import AiConfig, env_ai_config

logger = logging.getLogger(__name__)

#: Default only. The endpoint actually used is resolved per call from
#: ``settings.search_embedding_base_url`` — see :func:`embeddings_url`.
OPENAI_EMBEDDINGS_BASE_URL = "https://api.openai.com/v1"


def embeddings_url() -> str:
    """The embeddings endpoint this instance posts to (tripl-0tt4).

    Read at CALL time rather than bound at import, so a test — and an operator
    reading the value back out of a running process — sees the configured
    endpoint rather than whatever the environment held when this module was
    first imported.

    Built from a BASE exactly as ``llm_service`` builds its chat endpoint
    (``ai_base_url.rstrip("/") + "/chat/completions"``), so one provider's two
    endpoints are configured alike rather than one taking a base and the other a
    full URL.

    This was a hardcoded api.openai.com constant while the docs told self-hosters
    to point ``SEARCH_EMBEDDING_*`` at their own endpoint to keep plan text
    inside their infrastructure. Following that instruction sent the text to
    OpenAI anyway, with the operator's own credential attached.
    """
    return settings.search_embedding_base_url.rstrip("/") + "/embeddings"


def embed_query(text: str, *, config: AiConfig | None = None) -> list[float]:
    embeddings = embed_texts([text], config=config)
    return embeddings[0] if embeddings else []


def embed_texts(texts: list[str], *, config: AiConfig | None = None) -> list[list[float]]:
    cfg = config if config is not None else env_ai_config()
    if not cfg.search_embeddings_enabled:
        return []
    if cfg.search_embedding_provider != "openai":
        logger.warning(
            "Unsupported search embedding provider: %s",
            cfg.search_embedding_provider,
        )
        return []
    api_key = cfg.search_embedding_api_key
    if not api_key:
        logger.warning("Search embeddings enabled but no API key is configured")
        return []

    payload: dict[str, object] = {
        "model": cfg.search_embedding_model,
        "input": [text[:16_000] for text in texts],
    }
    # Dimensions stay env-only: the pgvector column is sized at migration
    # time, so a runtime override would silently corrupt the index.
    if settings.search_embedding_dimensions > 0:
        payload["dimensions"] = settings.search_embedding_dimensions

    request = urllib.request.Request(
        embeddings_url(),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError, urllib.error.URLError, TimeoutError:
        logger.exception("Search embedding request failed")
        return []

    parsed = cast(dict[str, Any], json.loads(body))
    data = parsed.get("data")
    if not isinstance(data, list):
        return []
    embeddings: list[list[float]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        raw_embedding = item.get("embedding")
        if not isinstance(raw_embedding, list):
            continue
        embeddings.append([float(value) for value in raw_embedding])
    return embeddings
