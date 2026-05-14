"""Lightweight Redis cache wrapper for read-heavy endpoints.

Design choices:
- Graceful degradation: if Redis is down or ``REDIS_URL`` is empty, every cache
  call is a no-op miss. Callers never see a Redis exception, they see an empty
  cache. This means the app still works with Redis off.
- JSON codec by default (Pydantic-dumpable payloads); callers pass a dumped
  ``str`` or dict and get a ``dict``/``list``/``None`` back.
- Namespaced keys: callers always pass a full key like ``"tripl:projects:list"``.
  Invalidation helpers use ``delete_prefix`` which scans via SCAN (not KEYS)
  so it's safe for production-sized keyspaces.

Testing:
- Unit tests (sqlite fixture) do NOT use Redis. Leave ``redis_url`` empty in
  the test Settings and calls become no-ops.
"""

from __future__ import annotations

import json
import logging
from typing import Any

try:
    import redis as redis_sync
    import redis.asyncio as redis_asyncio
except ImportError:  # pragma: no cover
    redis_asyncio = None  # type: ignore[assignment]
    redis_sync = None  # type: ignore[assignment]

from tripl.config import settings

logger = logging.getLogger(__name__)

_client: redis_asyncio.Redis | None = None
_client_failed: bool = False


def _get_client() -> redis_asyncio.Redis | None:
    global _client, _client_failed
    if _client_failed or not settings.redis_url or redis_asyncio is None:
        return None
    if _client is None:
        try:
            _client = redis_asyncio.from_url(
                settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
                socket_connect_timeout=1.0,
                socket_timeout=1.0,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("redis client init failed, disabling cache: %s", exc)
            _client_failed = True
            return None
    return _client


async def get_json(key: str) -> Any | None:
    """Return the cached JSON value at ``key``, or ``None`` on miss/error."""
    client = _get_client()
    if client is None:
        return None
    try:
        raw = await client.get(key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("redis GET %s failed: %s", key, exc)
        return None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError) as exc:
        logger.warning("redis GET %s: malformed JSON, dropping: %s", key, exc)
        await delete(key)
        return None


async def set_json(key: str, value: Any, ttl_seconds: int) -> None:
    """Store ``value`` as JSON at ``key`` with TTL. Swallows errors."""
    client = _get_client()
    if client is None:
        return
    try:
        payload = json.dumps(value, default=str, separators=(",", ":"))
        await client.set(key, payload, ex=ttl_seconds)
    except Exception as exc:  # noqa: BLE001
        logger.warning("redis SET %s failed: %s", key, exc)


async def delete(*keys: str) -> None:
    """Delete one or more exact keys. No-op on failure/missing keys."""
    if not keys:
        return
    client = _get_client()
    if client is None:
        return
    try:
        await client.delete(*keys)
    except Exception as exc:  # noqa: BLE001
        logger.warning("redis DEL %s failed: %s", keys, exc)


async def delete_prefix(prefix: str) -> None:
    """Delete all keys starting with ``prefix`` via SCAN + DEL (safe for prod).

    Avoids ``KEYS`` which is O(n) and blocking on large keyspaces.
    """
    client = _get_client()
    if client is None:
        return
    try:
        async for key in client.scan_iter(match=f"{prefix}*", count=500):
            await client.delete(key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("redis SCAN+DEL %s* failed: %s", prefix, exc)


# ── Sync helpers (for Celery workers — don't bridge back to asyncio) ────

_sync_client: redis_sync.Redis | None = None
_sync_client_failed: bool = False


def _get_sync_client() -> redis_sync.Redis | None:
    global _sync_client, _sync_client_failed
    if _sync_client_failed or not settings.redis_url or redis_sync is None:
        return None
    if _sync_client is None:
        try:
            _sync_client = redis_sync.Redis.from_url(
                settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
                socket_connect_timeout=1.0,
                socket_timeout=1.0,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("redis sync client init failed, disabling cache: %s", exc)
            _sync_client_failed = True
            return None
    return _sync_client


def sync_delete_prefix(prefix: str) -> None:
    """Sync variant of :func:`delete_prefix` for Celery workers."""
    client = _get_sync_client()
    if client is None:
        return
    try:
        for key in client.scan_iter(match=f"{prefix}*", count=500):
            client.delete(key)
    except Exception as exc:  # noqa: BLE001
        logger.warning("redis sync SCAN+DEL %s* failed: %s", prefix, exc)


async def close() -> None:
    """Close the shared client — call from FastAPI shutdown if needed."""
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        finally:
            _client = None


# ── Key-schema conventions ───────────────────────────────────────────────
# Put all cache keys through these helpers so invalidation prefixes stay
# aligned with reads. Never hand-roll a key at a call site.

def key_projects_list() -> str:
    return "tripl:projects:list"


def key_signals_all(slug: str) -> str:
    return f"tripl:signals:{slug}:all"


def key_data_sources_list() -> str:
    return "tripl:data_sources:list"


def key_event_types_list(slug: str) -> str:
    return f"tripl:event_types:{slug}:list"


def key_meta_fields_list(slug: str) -> str:
    return f"tripl:meta_fields:{slug}:list"


def prefix_projects() -> str:
    return "tripl:projects:"


def prefix_signals() -> str:
    return "tripl:signals:"


def prefix_data_sources() -> str:
    return "tripl:data_sources:"


def prefix_event_types(slug: str | None = None) -> str:
    return f"tripl:event_types:{slug}:" if slug else "tripl:event_types:"


def prefix_meta_fields(slug: str | None = None) -> str:
    return f"tripl:meta_fields:{slug}:" if slug else "tripl:meta_fields:"
