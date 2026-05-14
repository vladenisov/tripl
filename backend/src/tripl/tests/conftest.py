import asyncio
from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from tripl.config import settings

# Disable rate limiting in tests so the shared in-memory buckets across the
# session don't cause spurious 429s on repeated /auth/register calls.
settings.rate_limit_enabled = False

from tripl.database import get_session  # noqa: E402
from tripl.main import app  # noqa: E402
from tripl.middleware.rate_limit import login_rate_limiter, register_rate_limiter  # noqa: E402
from tripl.models import Base  # noqa: E402

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

engine = create_async_engine(TEST_DATABASE_URL)
TestSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


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


async def override_get_session() -> AsyncGenerator[AsyncSession]:
    async with TestSessionLocal() as session:
        yield session


app.dependency_overrides[get_session] = override_get_session


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
