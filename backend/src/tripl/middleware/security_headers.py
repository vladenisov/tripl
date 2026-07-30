"""Append baseline security headers to every HTTP response.

The middleware never overrides headers a downstream handler has already set,
so an endpoint that needs a custom CSP or X-Frame-Options can opt out by
setting its own value.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from tripl.config import settings

# Applied when the API serves the SPA itself (serve_frontend) and no explicit
# content_security_policy is configured, so the consolidated single container
# keeps the policy the standalone static tier used to set. Tuned for a Vite
# React SPA (Radix/Tailwind/recharts/codemirror need inline styles; scripts are
# bundled and same-origin).
_DEFAULT_SPA_CSP = (
    "default-src 'self'; script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
)


def build_security_headers() -> dict[str, str]:
    """The baseline header set, resolved from the current settings.

    Public because :class:`SecurityHeadersMiddleware` is not the only writer:
    the app's catch-all ``Exception`` handler answers from Starlette's
    ServerErrorMiddleware, which sits *outside* the whole user middleware stack,
    so a 500 never passes back through this middleware and has to attach the
    same headers itself (tripl-qu9m). Two hand-maintained copies of the list is
    exactly the drift that bug was — so both callers read this one function.

    Returns an empty mapping when security headers are disabled, so a 500 always
    carries precisely what a 200 on the same instance would.
    """
    if not settings.security_headers_enabled:
        return {}
    headers = {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        # No camera, microphone, geolocation, payment APIs.
        "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    }
    csp = settings.content_security_policy or (_DEFAULT_SPA_CSP if settings.serve_frontend else "")
    if csp:
        headers["content-security-policy"] = csp
    if settings.hsts_enabled:
        headers["strict-transport-security"] = (
            f"max-age={settings.hsts_max_age_seconds}; includeSubDomains"
        )
    return headers


class SecurityHeadersMiddleware:
    """Inject security headers into every ``http.response.start`` message."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        # Encode once at construction: the ASGI message carries raw bytes and
        # the values are settings-derived, so there is nothing to re-resolve
        # per response.
        self._headers = [(k.encode(), v.encode()) for k, v in build_security_headers().items()]

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
