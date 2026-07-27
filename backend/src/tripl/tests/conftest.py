import smtplib
import socket
from collections.abc import AsyncGenerator, Iterator

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from tripl.config import REGISTRATION_OPEN, settings

# Disable rate limiting in tests so the shared in-memory buckets across the
# session don't cause spurious 429s on repeated /auth/register calls.
settings.rate_limit_enabled = False

# Keep self-service registration open for the suite. Production defaults to
# "disabled" (fail closed, see Settings.registration_mode), but most suites
# register a second/third user to exercise editor and viewer roles. Tests that
# assert the closed behaviour set the mode themselves via monkeypatch or a
# persisted override.
settings.registration_mode = REGISTRATION_OPEN

from tripl.database import get_session  # noqa: E402
from tripl.main import app  # noqa: E402
from tripl.middleware.rate_limit import (  # noqa: E402
    login_rate_limiter,
    register_rate_limiter,
    status_rate_limiter,
)
from tripl.models import Base  # noqa: E402

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

engine = create_async_engine(TEST_DATABASE_URL)
TestSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


@event.listens_for(engine.sync_engine, "connect")
def _enable_sqlite_foreign_keys(dbapi_connection: object, _record: object) -> None:
    """Enforce ON DELETE CASCADE in tests, matching production Postgres.

    SQLite ignores foreign-key constraints unless ``PRAGMA foreign_keys=ON`` is
    set per connection, so without this the in-memory test DB leaves orphaned
    child rows on a parent delete (e.g. deleting a FieldDefinition strands its
    event_field_values), which then crashes the search reindexer on a NULL
    parent deref. StaticPool keeps one connection, so this fires once. (tripl-mdix)
    """
    cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


@pytest.fixture(scope="session", autouse=True)
async def _dispose_engine() -> AsyncGenerator[None]:
    """Close the shared async engine at session end.

    pytest-asyncio 1.x ignores a custom ``event_loop`` fixture; loop scope is
    pinned to ``session`` in pyproject so every test and fixture shares one loop
    and the StaticPool's single in-memory sqlite connection stays put. Disposing
    it here closes that connection deterministically (no ``ResourceWarning``).
    """
    yield
    await engine.dispose()


@pytest.fixture(autouse=True)
async def setup_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture(autouse=True)
def _reset_rate_limiters() -> None:
    """Drop accumulated bucket state between tests so order is irrelevant."""
    login_rate_limiter.reset()
    register_rate_limiter.reset()
    status_rate_limiter.reset()


async def override_get_session() -> AsyncGenerator[AsyncSession]:
    async with TestSessionLocal() as session:
        yield session


app.dependency_overrides[get_session] = override_get_session


class NetworkAccessError(RuntimeError):
    """Raised by the ``deny_network`` tripwire on any outbound attempt."""


@pytest.fixture
def deny_network(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Trip on ANY outbound network attempt (socket/httpx/smtplib).

    The in-memory SQLite DB and the in-process ASGI transport never open a real
    socket, so this only fires on genuine egress — making it the capstone guard
    for asserting the demo stack (provisioning, runtime tick, alert dispatch,
    metric collection over the synthetic source) is fully local. Opt-in and not
    autouse, so it never affects tests that don't request it.
    """

    def _blocked(*_args: object, **_kwargs: object) -> object:
        raise NetworkAccessError("outbound network attempted from a demo path")

    monkeypatch.setattr(socket, "socket", _blocked)
    monkeypatch.setattr(smtplib, "SMTP", _blocked)
    monkeypatch.setattr(smtplib, "SMTP_SSL", _blocked)
    monkeypatch.setattr(httpx.Client, "send", _blocked)
    monkeypatch.setattr(httpx.AsyncClient, "send", _blocked)
    yield


@pytest.fixture
async def anon_client() -> AsyncGenerator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def client(anon_client: AsyncClient) -> AsyncGenerator[AsyncClient]:
    resp = await anon_client.post(
        "/api/v1/auth/register",
        json={
            "email": "test@example.com",
            "password": "Password123!",
            "name": "Test User",
        },
    )
    assert resp.status_code == 201
    yield anon_client
