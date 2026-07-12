"""Project-scoped one-way realtime bus (tripl-2su6.8).

A completed scan / metric collection / demo tick publishes a small named event to
a per-project Redis channel; the SSE endpoint (``GET /projects/{slug}/events/stream``)
subscribes to that channel and relays events to the browser, which invalidates the
affected React-Query keys. This replaces most component-local polling; adaptive
polling remains a resilient fallback.

Design choices mirror :mod:`tripl.cache`:

- **Graceful degradation.** Every publish is a no-op when ``REDIS_URL`` is empty
  or Redis is down (tests, single-container dev without Redis). The SSE endpoint
  still connects and heartbeats in that case — clients see ``backend="degraded"``
  on the ``hello`` event and keep polling.
- **One-way only.** Server → client. There is no client → server path over the
  stream.
- **Publish after commit.** Callers publish only once the state change is
  committed, so a subscriber never sees an event for uncommitted state.
- **Bounded buffering + monotonic ids.** Each project channel keeps a capped
  ring buffer (``LPUSH`` + ``LTRIM``) keyed by a per-project ``INCR`` sequence so
  a reconnecting client can replay events it missed via the ``Last-Event-ID``
  cursor. Invalidation is idempotent, so a duplicated replay is harmless.

Testing: with Redis off the pub/sub calls no-op. The SSE generator
(:func:`sse_response_stream`) takes an injectable async message iterator, so
delivery + heartbeat + degraded behaviour are unit-testable without a live Redis.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from typing import Any

from tripl import cache

logger = logging.getLogger(__name__)

# ── Event types (SSE ``event:`` names) ───────────────────────────────────
EVENT_HELLO = "hello"
EVENT_SCAN_JOB_UPDATED = "scan_job.updated"
EVENT_METRIC_COLLECTION_UPDATED = "metric_collection.updated"
EVENT_ACTIVITY_CREATED = "activity.created"
EVENT_SIGNALS_UPDATED = "signals.updated"
EVENT_PROJECT_SUMMARY_UPDATED = "project_summary.updated"

# All publishable event types (``hello`` is synthesised by the endpoint, not
# published), kept in one place so the endpoint and tests agree.
PUBLISHABLE_EVENT_TYPES = (
    EVENT_SCAN_JOB_UPDATED,
    EVENT_METRIC_COLLECTION_UPDATED,
    EVENT_ACTIVITY_CREATED,
    EVENT_SIGNALS_UPDATED,
    EVENT_PROJECT_SUMMARY_UPDATED,
)

# Seconds between heartbeat comments — keeps proxies/load balancers from culling
# an idle stream and lets the endpoint notice a disconnected client.
HEARTBEAT_SECONDS = 15.0
# Per-project replay buffer depth. Small: reconnect replay is a nicety on top of
# idempotent invalidation + the polling fallback, not a delivery guarantee.
BUFFER_SIZE = 50

_CHANNEL_PREFIX = "tripl:events:"


def channel(slug: str) -> str:
    """Redis pub/sub channel for a project's event stream."""
    return f"{_CHANNEL_PREFIX}{slug}"


def _buffer_key(slug: str) -> str:
    return f"{_CHANNEL_PREFIX}{slug}:buffer"


def _seq_key(slug: str) -> str:
    return f"{_CHANNEL_PREFIX}{slug}:seq"


def backend_available() -> bool:
    """Whether the async Redis client is live (pub/sub can actually deliver)."""
    return cache.get_async_client() is not None


def _envelope(seq: int, event_type: str, slug: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": seq,
        "type": event_type,
        "data": {"project_slug": slug, **payload},
    }


# ── Publish (after-commit hooks) ─────────────────────────────────────────


def publish_project_event(slug: str, event_type: str, payload: dict[str, Any]) -> None:
    """Publish an event to a project's channel (SYNC — Celery workers).

    No-op when Redis is off. Never raises: a realtime failure must not fail the
    task that produced the (already-committed) state change.
    """
    client = cache.get_sync_client()
    if client is None:
        return
    try:
        seq = int(client.incr(_seq_key(slug)))
        raw = json.dumps(_envelope(seq, event_type, slug, payload), default=str)
        client.lpush(_buffer_key(slug), raw)
        client.ltrim(_buffer_key(slug), 0, BUFFER_SIZE - 1)
        client.publish(channel(slug), raw)
    except Exception as exc:  # noqa: BLE001
        logger.warning("realtime publish %s/%s failed: %s", slug, event_type, exc)


async def async_publish_project_event(slug: str, event_type: str, payload: dict[str, Any]) -> None:
    """Async variant of :func:`publish_project_event` (FastAPI request path)."""
    client = cache.get_async_client()
    if client is None:
        return
    try:
        seq = int(await client.incr(_seq_key(slug)))
        raw = json.dumps(_envelope(seq, event_type, slug, payload), default=str)
        await client.lpush(_buffer_key(slug), raw)
        await client.ltrim(_buffer_key(slug), 0, BUFFER_SIZE - 1)
        await client.publish(channel(slug), raw)
    except Exception as exc:  # noqa: BLE001
        logger.warning("realtime async publish %s/%s failed: %s", slug, event_type, exc)


async def replay_buffered_events(slug: str, after_id: int | None) -> list[dict[str, Any]]:
    """Buffered events with ``id > after_id`` in ascending order (reconnect replay).

    Returns ``[]`` when Redis is off, no cursor was supplied, or nothing is
    buffered past the cursor.
    """
    if after_id is None:
        return []
    client = cache.get_async_client()
    if client is None:
        return []
    try:
        raw_items = await client.lrange(_buffer_key(slug), 0, BUFFER_SIZE - 1)
    except Exception as exc:  # noqa: BLE001
        logger.warning("realtime replay %s failed: %s", slug, exc)
        return []
    events: list[dict[str, Any]] = []
    for raw in raw_items:  # newest → oldest (LPUSH order)
        try:
            envelope = json.loads(raw)
        except ValueError, TypeError:
            continue
        if isinstance(envelope, dict) and int(envelope.get("id", 0)) > after_id:
            events.append(envelope)
    events.reverse()  # ascending by id
    return events


async def redis_message_iterator(slug: str) -> AsyncIterator[dict[str, Any]]:
    """Yield live envelope dicts published to a project's channel.

    An empty async generator when Redis is off (the endpoint uses ``None`` /
    heartbeat-only in that case, so this is only entered when a client exists).
    """
    client = cache.get_async_client()
    if client is None:
        return
    pubsub = client.pubsub()
    await pubsub.subscribe(channel(slug))
    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            data = message.get("data")
            try:
                envelope = json.loads(data)
            except ValueError, TypeError:
                continue
            if isinstance(envelope, dict):
                yield envelope
    finally:
        try:
            await pubsub.unsubscribe(channel(slug))
            await pubsub.aclose()  # type: ignore[no-untyped-call]
        except Exception:  # noqa: BLE001
            pass


# ── SSE formatting + core stream generator ───────────────────────────────


def format_sse_event(envelope: dict[str, Any]) -> str:
    """Render an envelope as an ``id:``/``event:``/``data:`` SSE frame."""
    event_type = str(envelope.get("type", "message"))
    event_id = envelope.get("id")
    data = json.dumps(envelope.get("data", {}), default=str)
    lines = []
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event_type}")
    lines.append(f"data: {data}")
    return "\n".join(lines) + "\n\n"


def format_sse_comment(text: str) -> str:
    """Render an SSE comment (heartbeat) — ignored by ``EventSource``."""
    return f": {text}\n\n"


async def sse_response_stream(
    *,
    hello_payload: dict[str, Any],
    replay: Sequence[dict[str, Any]],
    messages: AsyncIterator[dict[str, Any]] | None,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    max_messages: int | None = None,
) -> AsyncIterator[str]:
    """Core SSE generator: hello → replay → live events interleaved with heartbeats.

    ``messages`` is an async iterator of envelope dicts (Redis, or a fake in
    tests); pass ``None`` for the Redis-off / degraded case (heartbeat only).
    ``max_messages`` bounds the loop for tests. Never raises on a disconnected
    client — it returns, letting ``StreamingResponse`` finish cleanly.
    """
    yield format_sse_event({"id": 0, "type": EVENT_HELLO, "data": hello_payload})
    for envelope in replay:
        yield format_sse_event(envelope)

    delivered = 0

    if messages is None:
        # Degraded: keep the socket warm so the client stays connected and polls.
        while max_messages is None or delivered < max_messages:
            if is_disconnected is not None and await is_disconnected():
                return
            await asyncio.sleep(heartbeat_seconds)
            yield format_sse_comment("heartbeat")
            delivered += 1
        return

    iterator = messages.__aiter__()
    while max_messages is None or delivered < max_messages:
        if is_disconnected is not None and await is_disconnected():
            return
        try:
            envelope = await asyncio.wait_for(iterator.__anext__(), timeout=heartbeat_seconds)
        except TimeoutError:
            yield format_sse_comment("heartbeat")
            continue
        except StopAsyncIteration:
            return
        yield format_sse_event(envelope)
        delivered += 1
