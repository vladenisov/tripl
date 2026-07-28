"""Cache-Control for the SPA the API serves itself.

``app.frontend()`` sets ``etag`` and ``last-modified`` but no ``Cache-Control``.
With no explicit freshness, RFC 9111 §4.2.2 lets a cache invent one — browsers
typically use ~10% of the document's age — so an ``index.html`` that had been
stable for a week stays "fresh" for hours after a deploy. The client then keeps
running the OLD document, whose ``<script>`` tags and lazy-import graph point at
content-hashed chunk names the new build no longer contains, and every
code-split route 404s. That is the intermittent "Failed to fetch dynamically
imported module" seen right after a release: it hits exactly the users whose
cached shell has not expired yet.

The split below is the standard pairing for a hashed build:

* ``/assets/*`` — the filename contains a content hash, so a given URL can never
  change meaning. Cache it as long as possible and never revalidate.
* everything else the SPA serves (``index.html`` and the deep-link fallback) —
  must be revalidated every time, or a client cannot discover the new chunk
  names. ``no-cache`` still allows caching, it just forbids reuse without
  revalidation, and the existing ``etag`` makes the common answer a cheap 304.

Headers already set downstream are never overwritten, matching
``SecurityHeadersMiddleware``.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from tripl.config import settings

# One year, the maximum practically honoured, plus ``immutable`` so a reload
# does not trigger a revalidation storm. Safe only because Vite puts a content
# hash in every filename under /assets.
_IMMUTABLE = b"public, max-age=31536000, immutable"
# Not ``no-store``: the response may still be cached, it just has to be
# revalidated before reuse, which the ETag makes cheap.
_REVALIDATE = b"no-cache"

_ASSET_PREFIX = "/assets/"
# Paths owned by the API. The SPA is mounted at "/" with low priority so these
# resolve first anyway; listing them keeps this middleware from touching an API
# response whose caching is the endpoint's business.
_API_PREFIXES = ("/api/", "/docs", "/redoc", "/openapi.json")
_API_PATHS = frozenset({"/health", "/metrics"})


def _is_api_path(path: str) -> bool:
    return path in _API_PATHS or path.startswith(_API_PREFIXES)


class StaticCacheMiddleware:
    """Set ``Cache-Control`` on responses served from the SPA build."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not settings.serve_frontend:
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if _is_api_path(path):
            await self.app(scope, receive, send)
            return

        is_asset = path.startswith(_ASSET_PREFIX)

        async def send_with_cache_control(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers") or [])
                names = {name.lower() for name, _ in headers}
                if b"cache-control" not in names:
                    value: bytes | None = None
                    if is_asset:
                        value = _IMMUTABLE
                    else:
                        # Content-type rather than path: a deep link such as
                        # /p/acme/events is answered with index.html, so the URL
                        # alone does not identify the SPA shell.
                        content_type = next(
                            (v for name, v in headers if name.lower() == b"content-type"), b""
                        )
                        if content_type.startswith(b"text/html"):
                            value = _REVALIDATE
                    if value is not None:
                        headers.append((b"cache-control", value))
                        message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_cache_control)
