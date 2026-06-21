"""Shared sync SQLAlchemy engine + session factory for Celery tasks.

Each worker process creates ONE engine on first use (lazy), then every task
checks out a session from that engine's connection pool. This avoids the
overhead of spinning up a fresh engine per task invocation.

Tests do not touch this module directly — they monkey-patch the
``_get_sync_session`` name inside each task module's globals.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from tripl.config import settings
from tripl.db_config import MAX_OVERFLOW, POOL_PRE_PING, POOL_RECYCLE_SECONDS, POOL_SIZE

if TYPE_CHECKING:
    from tripl.core.adapters.base import BaseAdapter
    from tripl.models.data_source import DataSource

_engine: Engine | None = None
_session_local: sessionmaker[Session] | None = None


def _ensure_initialized() -> sessionmaker[Session]:
    global _engine, _session_local
    if _session_local is None:
        _engine = create_engine(
            settings.sync_database_url,
            echo=settings.debug,
            pool_size=POOL_SIZE,
            max_overflow=MAX_OVERFLOW,
            pool_pre_ping=POOL_PRE_PING,
            pool_recycle=POOL_RECYCLE_SECONDS,
        )
        _session_local = sessionmaker(_engine, expire_on_commit=False)
    return _session_local


def SyncSessionLocal() -> Session:  # noqa: N802  — emulates sessionmaker() call shape
    """Return a new sync Session from the shared engine pool."""
    return _ensure_initialized()()


def _get_sync_session() -> Session:
    """Canonical sync-session factory shared by every Celery task module.

    Task modules import this under the same ``_get_sync_session`` name so tests
    can keep monkey-patching it via each module's globals.
    """
    return SyncSessionLocal()


def _build_adapter(ds: DataSource) -> BaseAdapter:
    """Canonical warehouse-adapter builder shared by Celery task modules."""
    from tripl.core.adapters.registry import build_adapter

    return build_adapter(ds)
