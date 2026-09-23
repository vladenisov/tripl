"""Bound request bodies before FastAPI parses them or checks dependencies."""

from __future__ import annotations

import re

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from tripl.config import settings

_PHOTO_UPLOAD = re.compile(r"^/api/v1/projects/[^/]+/events/[^/]+/photos/?$")
_MIB = 1024 * 1024


class _BodyTooLarge(Exception):
    pass


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        photo_upload = scope["method"] == "POST" and _PHOTO_UPLOAD.fullmatch(scope["path"])
        limit = (
            (settings.photo_max_size_mb + 1) * _MIB
            if photo_upload
            else settings.max_request_body_mb * _MIB
        )
        headers = dict(scope.get("headers", []))
        declared = headers.get(b"content-length", b"").strip()
        if declared.isdigit() and int(declared) > limit:
            await self._reject(scope, receive, send)
            return

        received = 0

        async def counting_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _BodyTooLarge
            return message

        try:
            await self.app(scope, counting_receive, send)
        except _BodyTooLarge:
            await self._reject(scope, receive, send)

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send) -> None:
        await JSONResponse({"detail": "Request body too large"}, status_code=413)(
            scope, receive, send
        )
