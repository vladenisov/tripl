"""Cache-Control for the served SPA build.

Regression cover for the intermittent post-deploy 404s: without explicit
freshness on index.html a browser invents its own, keeps running the old shell,
and requests content-hashed chunks the new build no longer has.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.types import Receive, Scope, Send

from tripl.config import settings
from tripl.middleware.static_cache import StaticCacheMiddleware


def _app_returning(content_type: bytes, extra_headers: list[tuple[bytes, bytes]] | None = None):
    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", content_type), *(extra_headers or [])],
            }
        )
        await send({"type": "http.response.body", "body": b"x"})

    return StaticCacheMiddleware(app)


async def _get(app: object, path: str) -> dict[str, str]:
    transport = ASGITransport(app=app)  # type: ignore[arg-type]
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(path)
    return {k.lower(): v for k, v in response.headers.items()}


@pytest.fixture(autouse=True)
def _serving_frontend(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "serve_frontend", True)


@pytest.mark.asyncio
async def test_index_html_must_be_revalidated() -> None:
    """The shell names the chunk files, so a stale copy is what breaks a deploy."""
    headers = await _get(_app_returning(b"text/html; charset=utf-8"), "/")

    assert headers["cache-control"] == "no-cache"


@pytest.mark.asyncio
async def test_deep_link_fallback_is_also_revalidated() -> None:
    """A deep link is answered with index.html, so the path alone cannot classify it."""
    headers = await _get(_app_returning(b"text/html; charset=utf-8"), "/p/acme/events")

    assert headers["cache-control"] == "no-cache"


@pytest.mark.asyncio
async def test_hashed_assets_are_immutable() -> None:
    """The filename carries a content hash, so the URL can never change meaning."""
    headers = await _get(_app_returning(b"text/javascript"), "/assets/EventsPage-B95qoXx.js")

    assert headers["cache-control"] == "public, max-age=31536000, immutable"


@pytest.mark.asyncio
async def test_api_responses_are_left_alone() -> None:
    """Caching an API response is the endpoint's business, not this middleware's."""
    headers = await _get(_app_returning(b"application/json"), "/api/v1/projects")

    assert "cache-control" not in headers


@pytest.mark.asyncio
async def test_an_explicit_cache_control_is_never_overwritten() -> None:
    app = _app_returning(b"text/html", [(b"cache-control", b"private, max-age=60")])

    headers = await _get(app, "/")

    assert headers["cache-control"] == "private, max-age=60"


@pytest.mark.asyncio
async def test_noop_when_the_api_does_not_serve_the_frontend(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With a separate static tier the headers are that tier's responsibility."""
    monkeypatch.setattr(settings, "serve_frontend", False)

    headers = await _get(_app_returning(b"text/html"), "/")

    assert "cache-control" not in headers
