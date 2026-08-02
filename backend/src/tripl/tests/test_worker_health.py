"""The classification table for GET /api/v1/system/worker-health.

The honesty of the whole feature lives here: a banner that cries wolf gets
dismissed, and one that stays quiet while the pipeline is dead is worse than
no banner at all. So every branch is pinned, especially the ones that must
report ``unknown`` rather than guess.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from tripl.services import worker_health_service
from tripl.services.worker_health_service import WORKER_HEARTBEAT_STALE_SECONDS


class _FakeRedis:
    """Minimal stand-in: returns a canned value or raises."""

    def __init__(self, value: Any = None, error: Exception | None = None) -> None:
        self._value = value
        self._error = error

    async def get(self, key: str) -> Any:
        if self._error is not None:
            raise self._error
        return self._value


def _use_client(monkeypatch: pytest.MonkeyPatch, client: Any) -> None:
    monkeypatch.setattr(worker_health_service.cache, "get_async_client", lambda: client)


@pytest.mark.asyncio
async def test_reports_ok_when_the_heartbeat_is_fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    # Arrange
    stamp = datetime.now(UTC) - timedelta(seconds=5)
    _use_client(monkeypatch, _FakeRedis(stamp.isoformat()))

    # Act
    health = await worker_health_service.get_worker_health()

    # Assert
    assert health.state == "ok"
    assert health.last_heartbeat_at == stamp
    assert health.stale_after_seconds == WORKER_HEARTBEAT_STALE_SECONDS


@pytest.mark.asyncio
async def test_reports_stale_once_the_heartbeat_stops(monkeypatch: pytest.MonkeyPatch) -> None:
    # Arrange — one second past the threshold is already stale.
    stamp = datetime.now(UTC) - timedelta(seconds=WORKER_HEARTBEAT_STALE_SECONDS + 1)
    _use_client(monkeypatch, _FakeRedis(stamp.isoformat()))

    # Act
    health = await worker_health_service.get_worker_health()

    # Assert — the last-seen time is kept so the UI can say how long it has been.
    assert health.state == "stale"
    assert health.last_heartbeat_at == stamp


@pytest.mark.asyncio
async def test_reports_never_when_no_heartbeat_was_ever_written(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_client(monkeypatch, _FakeRedis(None))

    health = await worker_health_service.get_worker_health()

    assert health.state == "never"
    assert health.last_heartbeat_at is None


@pytest.mark.asyncio
async def test_reports_unknown_rather_than_ok_when_redis_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Without Redis the heartbeat has nowhere to live, so liveness is genuinely
    # unknowable — claiming "ok" here would be a lie, "never" a false alarm.
    _use_client(monkeypatch, None)

    health = await worker_health_service.get_worker_health()

    assert health.state == "unknown"
    assert health.last_heartbeat_at is None


@pytest.mark.asyncio
async def test_reports_unknown_when_the_cache_read_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A cache outage says nothing about the worker, so it must not read as dead.
    _use_client(monkeypatch, _FakeRedis(error=ConnectionError("redis is down")))

    health = await worker_health_service.get_worker_health()

    assert health.state == "unknown"


@pytest.mark.asyncio
async def test_reports_unknown_for_an_unparseable_stamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _use_client(monkeypatch, _FakeRedis("not-a-timestamp"))

    health = await worker_health_service.get_worker_health()

    assert health.state == "unknown"


@pytest.mark.asyncio
async def test_treats_a_naive_stamp_as_utc_instead_of_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Redis hands back whatever was written; a naive value would otherwise blow
    # up the age subtraction and take the endpoint down with it.
    stamp = datetime.now(UTC).replace(tzinfo=None)
    _use_client(monkeypatch, _FakeRedis(stamp.isoformat()))

    health = await worker_health_service.get_worker_health()

    assert health.state == "ok"


@pytest.mark.asyncio
async def test_decodes_bytes_from_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    # A client configured without decode_responses returns bytes.
    stamp = datetime.now(UTC)
    _use_client(monkeypatch, _FakeRedis(stamp.isoformat().encode()))

    health = await worker_health_service.get_worker_health()

    assert health.state == "ok"
    assert health.last_heartbeat_at == stamp
