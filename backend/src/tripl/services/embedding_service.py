from __future__ import annotations

import http.client
import json
import logging
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
    # ``OSError`` is the transport family in one name: ``URLError``, its
    # ``HTTPError`` subclass, and ``TimeoutError`` all derive from it.
    # ``http.client.HTTPException`` is the other half — a connection dropped
    # mid-body raises ``IncompleteRead`` out of ``read()``, after the 200 has
    # already been accepted, so nothing downstream would catch it.
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            body = response.read()
    except OSError, http.client.HTTPException:
        logger.exception("Search embedding request failed")
        return []

    # A 200 is not a promise of a parseable body (tripl-l33u). The endpoint is
    # operator-configurable, so a gateway in front of a self-hosted provider can
    # answer 200 with an HTML error page (JSONDecodeError, a ValueError), bytes
    # that are not UTF-8 at all (UnicodeDecodeError, also a ValueError — which is
    # why the undecoded body is handed to ``json.loads`` inside this guard rather
    # than decoded above it), a JSON array instead of an object (AttributeError
    # on ``.get``), or a vector carrying a null or a string (TypeError/ValueError
    # in ``float``). All of them degrade to [] like the transport failures above,
    # because every caller — the request path's semantic leg and the worker task
    # alike — is written against "no embeddings" and not against an exception.
    #
    # Vectors land at the position the PROVIDER named, not at the position they
    # happened to arrive in: an OpenAI-compatible ``data`` array carries an
    # ``index`` per item and does not promise order. Skipping an unusable entry
    # while appending to a list attributed every later vector to the wrong text —
    # document N's embedding written onto document N-1, silently.
    try:
        parsed = cast(dict[str, Any], json.loads(body))
        data = parsed.get("data")
        if not isinstance(data, list):
            return []
        by_index: dict[int, list[float]] = {}
        for position, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            raw_embedding = item.get("embedding")
            if not isinstance(raw_embedding, list):
                continue
            index = item.get("index")
            # ``bool`` is an ``int`` subclass, so a JSON ``true`` would key slot
            # 1. A provider that omits ``index`` entirely falls back to array
            # position, which is safe now only because a skipped entry leaves its
            # OWN slot empty rather than pulling the rest of the array forward.
            if not isinstance(index, int) or isinstance(index, bool):
                index = position
            by_index[index] = [float(value) for value in raw_embedding]
    except AttributeError, TypeError, ValueError:
        logger.exception("Search embedding response could not be parsed")
        return []

    # Nothing usable anywhere is a REQUEST-level failure, not one per document:
    # the worker retries an empty list but marks a gapped one failed, and "the
    # gateway answered with no vectors" is not evidence about any one document.
    if not by_index:
        return []
    return [by_index.get(position, []) for position in range(len(texts))]
