"""Tests for the async DB engine connection-pool configuration.

The async engine must mirror the worker's sync engine pool tuning
(``pool_size=5``, ``max_overflow=10``, ``pool_pre_ping=True``,
``pool_recycle=1800``) so the API process does not exhaust or stale out
its connections under load. See ``tripl.worker.db`` for the sync analogue.
"""

from sqlalchemy.ext.asyncio import AsyncEngine

from tripl.database import engine


def test_engine_is_async_engine() -> None:
    assert isinstance(engine, AsyncEngine)


def test_pool_pre_ping_enabled() -> None:
    assert engine.pool._pre_ping is True


def test_pool_recycle_is_1800() -> None:
    assert engine.pool._recycle == 1800


def test_pool_size_is_5() -> None:
    assert engine.pool.size() == 5


def test_pool_max_overflow_is_10() -> None:
    assert engine.pool._max_overflow == 10
