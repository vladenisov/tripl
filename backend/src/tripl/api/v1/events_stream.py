"""Project-scoped one-way Server-Sent Events stream (tripl-2su6.8).

``GET /projects/{slug}/events/stream`` relays committed state changes (scan jobs,
metric collections, activity, signals, project summaries) to the browser so a
completed background job refreshes every visible surface without a reload.

Auth + scope: the router is mounted with ``Depends(get_current_user)`` (see
``router.py``), which authenticates the session/API key and, for a project-scoped
API key, enforces that it may only reach ITS own project (``_enforce_project_scope``).
Anonymous callers get 401; a foreign project-scoped key gets 403. The handler then
resolves the slug, 404-ing an unknown/other project for a session user.

The endpoint is excluded from the OpenAPI schema (``include_in_schema=False``): SSE
is consumed by the browser ``EventSource``, not the generated typed client, and a
streaming ``text/event-stream`` response has no useful JSON schema.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from tripl import realtime
from tripl.api.deps import SessionDep
from tripl.services.project_service import get_project_id_by_slug

router = APIRouter(prefix="/projects/{slug}/events", tags=["events"])

# Streaming-friendly headers: disable caching and proxy buffering so events flush
# immediately (nginx honours ``X-Accel-Buffering: no``).
_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
}


def _parse_last_event_id(request: Request) -> int | None:
    """Reconnect cursor from the ``Last-Event-ID`` header or ``?last_event_id=``.

    ``EventSource`` resends the header natively; a manual reconnect (custom
    backoff) passes the query param instead. Malformed values are ignored.
    """
    raw = request.headers.get("Last-Event-ID") or request.query_params.get("last_event_id")
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError, TypeError:
        return None


@router.get("/stream", include_in_schema=False)
async def stream_project_events(
    slug: str,
    request: Request,
    session: SessionDep,
    # Optional cap on events/heartbeats before the server closes the stream (the
    # client reconnects). Unset in production = an open-ended stream; tests pass
    # ``0`` for a finite greet-and-close response (ASGITransport buffers the whole
    # body, so an unbounded stream can't be read over the test transport).
    max_events: Annotated[int | None, Query(ge=0)] = None,
) -> StreamingResponse:
    # 404 an unknown/foreign project for a session user (a project-scoped API key
    # was already fenced to its own project by the router-level dependency).
    await get_project_id_by_slug(session, slug)

    available = realtime.backend_available()
    last_event_id = _parse_last_event_id(request)
    replay = await realtime.replay_buffered_events(slug, last_event_id)
    messages = realtime.redis_message_iterator(slug) if available else None
    hello = {"project_slug": slug, "backend": "redis" if available else "degraded"}

    generator = realtime.sse_response_stream(
        hello_payload=hello,
        replay=replay,
        messages=messages,
        is_disconnected=request.is_disconnected,
        max_messages=max_events,
    )
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )
