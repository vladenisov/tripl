"""Append baseline security headers to every HTTP response.

The middleware never overrides headers a downstream handler has already set,
so an endpoint that needs a custom CSP or X-Frame-Options can opt out by
setting its own value.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from tripl.config import settings


def _build_static_headers() -> list[tuple[bytes, bytes]]:
    headers: list[tuple[bytes, bytes]] = [
        (b"x-content-type-options", b"nosniff"),
        (b"x-frame-options", b"DENY"),
        (b"referrer-policy", b"strict-origin-when-cross-origin"),
        # No camera, microphone, geolocation, payment APIs.
        (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=()"),
    ]
    if settings.content_security_policy:
        headers.append(
            (b"content-security-policy", settings.content_security_policy.encode())
        )
    if settings.hsts_enabled:
        headers.append(
            (
                b"strict-transport-security",
                f"max-age={settings.hsts_max_age_seconds}; includeSubDomains".encode(),
            )
        )
    return headers


class SecurityHeadersMiddleware:
    """Inject security headers into every ``http.response.start`` message."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self._headers = _build_static_headers()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = message.get("headers") or []
                existing_names = {name.lower() for name, _ in existing}
                merged = list(existing)
                for name, value in self._headers:
                    if name not in existing_names:
                        merged.append((name, value))
                message["headers"] = merged
            await send(message)

        await self.app(scope, receive, send_with_headers)
