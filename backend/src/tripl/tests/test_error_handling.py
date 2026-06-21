from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

import tripl.database as database
import tripl.main as main_module
from tripl.database import get_session
from tripl.main import app


@pytest.mark.asyncio
async def test_get_session_rolls_back_on_handler_error() -> None:
    """A handler raising mid-request must leave the connection clean: the
    session is rolled back and the exception re-raised."""
    fake_session = AsyncMock()

    class _FakeCtx:
        async def __aenter__(self) -> object:
            return fake_session

        async def __aexit__(self, *exc: object) -> bool:
            return False

    # Swap the sessionmaker for a fake so we can assert rollback without a real
    # engine, then drive the generator manually and throw at the yield point.
    original = database.async_session
    database.async_session = lambda: _FakeCtx()  # type: ignore[assignment]
    try:
        gen = get_session()
        await gen.__anext__()
        with pytest.raises(RuntimeError):
            await gen.athrow(RuntimeError("boom"))
    finally:
        database.async_session = original

    fake_session.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_unhandled_exception_returns_generic_500_with_request_id() -> None:
    @app.get("/__boom__", include_in_schema=False)
    async def _boom() -> None:
        raise RuntimeError("kaboom")

    try:
        transport = ASGITransport(app=app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.get("/__boom__")
        assert resp.status_code == 500
        body = resp.json()
        assert body["detail"] == "Internal server error"
        # The request id is echoed so logs can be correlated.
        assert body["request_id"]
        assert "kaboom" not in resp.text
    finally:
        app.router.routes = [
            r for r in app.router.routes if getattr(r, "path", None) != "/__boom__"
        ]


@pytest.mark.asyncio
async def test_health_db_failure_returns_generic_body_without_exception_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The unauthenticated /health probe must not leak DSN/driver detail: on a DB
    failure it returns a generic 503 body with no raw exception string."""
    secret = "postgresql+asyncpg://supersecretuser:supersecretpw@db-host:5432/tripl"

    class _ExplodingEngine:
        # AsyncEngine.connect is a read-only method, so we can't patch it on the
        # real engine instance; swap in a stand-in whose connect() raises before
        # any context-manager entry, simulating an unreachable database.
        def connect(self) -> object:
            raise RuntimeError(secret)

    monkeypatch.setattr(main_module, "engine", _ExplodingEngine())

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/health")

    assert resp.status_code == 503
    body = resp.json()
    assert body == {"status": "error", "component": "database"}
    # No exception text — neither a "detail" field nor the leaked secret anywhere.
    assert "detail" not in body
    assert "supersecret" not in resp.text
    assert "asyncpg" not in resp.text
