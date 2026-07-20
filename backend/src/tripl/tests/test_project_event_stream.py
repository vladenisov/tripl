"""Project-scoped SSE live-update stream (tripl-2su6.8).

Covers three layers without a live Redis (tests run with ``redis_url`` empty, so
the pub/sub bus degrades to a no-op):

* auth + project scope on ``GET /projects/{slug}/events/stream``;
* the pub/sub publish helpers no-op safely when Redis is off;
* the core SSE generator (``sse_response_stream``) — hello, replay, live delivery
  from a faked message iterator, and heartbeat-only degraded mode.

Heavy browser E2E (two clients on one job, reconnect, fallback) is deferred to
tripl-2su6.10.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest
from httpx import AsyncClient
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from tripl import realtime


async def _create_project(client: AsyncClient, slug: str) -> None:
    resp = await client.post("/api/v1/projects", json={"name": slug.upper(), "slug": slug})
    assert resp.status_code == 201, resp.text


async def _issue_project_key(client: AsyncClient, *, project_slug: str) -> str:
    resp = await client.post(
        "/api/v1/me/api-keys",
        json={"name": "agent", "scope": "read", "project_slug": project_slug},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["token"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _fake_messages(items: list[dict]) -> AsyncIterator[dict]:
    for item in items:
        yield item


async def _delayed_message(item: dict, delay: float) -> AsyncIterator[dict]:
    await asyncio.sleep(delay)
    yield item


async def _ending_messages(delay: float) -> AsyncIterator[dict]:
    await asyncio.sleep(delay)
    if False:
        yield {}


# ── Endpoint auth + scope ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stream_requires_auth(anon_client: AsyncClient) -> None:
    resp = await anon_client.get("/api/v1/projects/whatever/events/stream")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_stream_unknown_project_is_404_for_session_user(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/projects/does-not-exist/events/stream")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_session_user_can_subscribe(client: AsyncClient) -> None:
    await _create_project(client, "stream-owner")
    # ``max_events=0`` greets and closes so the (buffering) test transport can read
    # a finite body; production leaves it unset for an open-ended stream.
    resp = await client.get("/api/v1/projects/stream-owner/events/stream?max_events=0")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    # The endpoint greets with a `hello` event announcing whether the realtime
    # backend is live; with Redis off (tests) it reports "degraded".
    assert "event: hello" in resp.text
    assert "degraded" in resp.text


@pytest.mark.asyncio
async def test_scoped_key_may_subscribe_to_its_own_project(client: AsyncClient) -> None:
    await _create_project(client, "scoped-own")
    token = await _issue_project_key(client, project_slug="scoped-own")
    resp = await client.get(
        "/api/v1/projects/scoped-own/events/stream?max_events=0", headers=_bearer(token)
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_scoped_key_cannot_subscribe_to_foreign_project(client: AsyncClient) -> None:
    await _create_project(client, "scoped-a")
    await _create_project(client, "scoped-b")
    token = await _issue_project_key(client, project_slug="scoped-a")
    resp = await client.get("/api/v1/projects/scoped-b/events/stream", headers=_bearer(token))
    assert resp.status_code == 403


# ── Pub/sub bus degrades to a no-op with Redis off ───────────────────────


@pytest.mark.asyncio
async def test_publish_is_noop_without_redis() -> None:
    # Must not raise and must be a no-op (redis_url empty in tests).
    realtime.publish_project_event("s", realtime.EVENT_SCAN_JOB_UPDATED, {"job_id": "1"})
    await realtime.async_publish_project_event("s", realtime.EVENT_SIGNALS_UPDATED, {})
    assert await realtime.replay_buffered_events("s", 5) == []
    assert realtime.backend_available() is False


class _FailingPubSub:
    def __init__(
        self,
        *,
        subscribe_error: Exception | None = None,
        unsubscribe_error: Exception | None = None,
    ) -> None:
        self.subscribe_error = subscribe_error
        self.unsubscribe_error = unsubscribe_error
        self.subscribed = False
        self.unsubscribed = False
        self.closed = False

    async def subscribe(self, _channel: str) -> None:
        if self.subscribe_error is not None:
            raise self.subscribe_error
        self.subscribed = True

    async def listen(self) -> AsyncIterator[dict]:
        raise RedisTimeoutError("socket read timed out")
        yield {}

    async def unsubscribe(self, _channel: str) -> None:
        self.unsubscribed = True
        if self.unsubscribe_error is not None:
            raise self.unsubscribe_error

    async def aclose(self) -> None:
        self.closed = True


class _FakeRedisClient:
    def __init__(self, pubsub: _FailingPubSub) -> None:
        self._pubsub = pubsub

    def pubsub(self) -> _FailingPubSub:
        return self._pubsub


@pytest.mark.asyncio
async def test_redis_iterator_ends_cleanly_on_socket_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pubsub = _FailingPubSub()
    monkeypatch.setattr(
        realtime.cache,
        "get_async_client",
        lambda: _FakeRedisClient(pubsub),
    )

    events = [event async for event in realtime.redis_message_iterator("demo")]

    assert events == []
    assert pubsub.subscribed is True
    assert pubsub.unsubscribed is True
    assert pubsub.closed is True


@pytest.mark.asyncio
async def test_redis_iterator_ends_cleanly_when_subscribe_disconnects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pubsub = _FailingPubSub(subscribe_error=RedisConnectionError("redis down"))
    monkeypatch.setattr(
        realtime.cache,
        "get_async_client",
        lambda: _FakeRedisClient(pubsub),
    )

    events = [event async for event in realtime.redis_message_iterator("demo")]

    assert events == []
    assert pubsub.subscribed is False
    assert pubsub.unsubscribed is False
    assert pubsub.closed is True


@pytest.mark.asyncio
async def test_redis_iterator_closes_pubsub_when_unsubscribe_disconnects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pubsub = _FailingPubSub(unsubscribe_error=RedisConnectionError("redis still down"))
    monkeypatch.setattr(
        realtime.cache,
        "get_async_client",
        lambda: _FakeRedisClient(pubsub),
    )

    events = [event async for event in realtime.redis_message_iterator("demo")]

    assert events == []
    assert pubsub.unsubscribed is True
    assert pubsub.closed is True


# ── Core SSE generator ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_generator_delivers_hello_then_live_event() -> None:
    envelope = {
        "id": 7,
        "type": realtime.EVENT_SCAN_JOB_UPDATED,
        "data": {"project_slug": "p", "status": "completed"},
    }
    chunks = [
        chunk
        async for chunk in realtime.sse_response_stream(
            hello_payload={"project_slug": "p", "backend": "redis"},
            replay=[],
            messages=_fake_messages([envelope]),
            heartbeat_seconds=5,
            max_messages=1,
        )
    ]
    body = "".join(chunks)
    assert "event: hello" in body
    assert f"event: {realtime.EVENT_SCAN_JOB_UPDATED}" in body
    assert '"status": "completed"' in body
    assert "id: 7" in body


@pytest.mark.asyncio
async def test_generator_keeps_live_read_pending_across_heartbeats() -> None:
    envelope = {
        "id": 8,
        "type": realtime.EVENT_SCAN_JOB_UPDATED,
        "data": {"project_slug": "p", "status": "completed"},
    }
    chunks = [
        chunk
        async for chunk in realtime.sse_response_stream(
            hello_payload={"project_slug": "p", "backend": "redis"},
            replay=[],
            messages=_delayed_message(envelope, 0.035),
            heartbeat_seconds=0.01,
            max_messages=1,
        )
    ]
    body = "".join(chunks)
    assert body.count(": heartbeat") >= 2
    assert f"event: {realtime.EVENT_SCAN_JOB_UPDATED}" in body
    assert "id: 8" in body


@pytest.mark.asyncio
async def test_generator_disconnect_drains_completed_iterator_cleanly() -> None:
    disconnect_checks = 0

    async def is_disconnected() -> bool:
        nonlocal disconnect_checks
        disconnect_checks += 1
        if disconnect_checks == 1:
            return False
        await asyncio.sleep(0.02)
        return True

    chunks = [
        chunk
        async for chunk in realtime.sse_response_stream(
            hello_payload={"project_slug": "p", "backend": "redis"},
            replay=[],
            messages=_ending_messages(0.015),
            heartbeat_seconds=0.01,
            is_disconnected=is_disconnected,
        )
    ]

    assert "event: hello" in "".join(chunks)
    assert any(": heartbeat" in chunk for chunk in chunks)


@pytest.mark.asyncio
async def test_generator_replays_buffered_events_before_live() -> None:
    replayed = {
        "id": 3,
        "type": realtime.EVENT_SIGNALS_UPDATED,
        "data": {"project_slug": "p"},
    }
    chunks = [
        chunk
        async for chunk in realtime.sse_response_stream(
            hello_payload={"project_slug": "p", "backend": "redis"},
            replay=[replayed],
            messages=_fake_messages([]),
            heartbeat_seconds=5,
        )
    ]
    body = "".join(chunks)
    assert body.index("event: hello") < body.index(f"event: {realtime.EVENT_SIGNALS_UPDATED}")


@pytest.mark.asyncio
async def test_generator_degraded_mode_heartbeats_only() -> None:
    chunks = [
        chunk
        async for chunk in realtime.sse_response_stream(
            hello_payload={"project_slug": "p", "backend": "degraded"},
            replay=[],
            messages=None,
            heartbeat_seconds=0.01,
            max_messages=2,
        )
    ]
    body = "".join(chunks)
    assert "event: hello" in body
    assert ": heartbeat" in body
    # No live events are fabricated in degraded mode.
    assert f"event: {realtime.EVENT_SCAN_JOB_UPDATED}" not in body


def test_sse_formatting_helpers() -> None:
    frame = realtime.format_sse_event({"id": 42, "type": "x.y", "data": {"a": 1}})
    assert frame == 'id: 42\nevent: x.y\ndata: {"a": 1}\n\n'
    assert realtime.format_sse_comment("heartbeat") == ": heartbeat\n\n"
