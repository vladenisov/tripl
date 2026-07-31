"""The synchronous CLI seam over an asynchronous client.

``commands.Handler`` is synchronous because a CLI owns its own ``main`` and has
to hand an exit code back to it; ``TriplClient`` is asynchronous because it is
shared with tripl-mcp, which needs it that way (tripl-ey6j.1). This module is
the only place the two meet, so a command body reads as a straight line and
there is exactly one ``asyncio.run`` in the process.

Credentials are demanded BEFORE the event loop opens. That keeps "you have not
configured a key" (``EXIT_USAGE``, no socket touched, nothing to report) cleanly
separated from "the instance rejected your key" — two failures that produced the
same shrug during the 2026-07-28..31 incident.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence

import httpx

from tripl_cli.client import create_http_client
from tripl_cli.config import Config, require_api_key, require_base_url

# How many reads may be in flight at once. doctor's drift scan is one request
# per event type, and a self-hosted tripl is commonly one uvicorn worker in
# front of one Postgres — a diagnostic tool that saturates the instance it is
# diagnosing reports on the load it created. Six keeps a 200-event-type scan
# well under a minute without ever being the busiest client on the box.
MAX_CONCURRENT_REQUESTS = 6

# Deliberately shorter than the client's own 30 s default: doctor's contract is
# that it ANSWERS, so a hung endpoint has to become a finding rather than a
# wait. The connectivity check short-circuits the rest of the run, which bounds
# the worst case to roughly one timeout instead of one per call.
REQUEST_TIMEOUT_SECONDS = 10.0


def run_async[T](
    config: Config,
    body: Callable[[httpx.AsyncClient], Awaitable[T]],
    *,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
) -> T:
    """Run one async command body against one connection pool, then close it.

    ``create_http_client`` is called unqualified on purpose: tests monkeypatch
    the binding in this module to prove a command opens exactly one pool and
    closes it even when the body raises.
    """
    base_url = require_base_url(config)
    api_key = require_api_key(config)

    async def _main() -> T:
        # `async with` rather than an explicit aclose(): the close has to happen
        # on the exception path too, and that is the path where a leaked pool
        # actually shows up (as an "Unclosed client session" warning that buries
        # the real error).
        async with create_http_client(base_url, api_key, timeout=timeout) as client:
            return await body(client)

    return asyncio.run(_main())


async def gather_bounded[T](
    awaitables: Sequence[Awaitable[T]],
    limit: int = MAX_CONCURRENT_REQUESTS,
) -> list[T]:
    """Await everything, at most ``limit`` at a time, preserving input order.

    Order is part of the contract, not an accident of the implementation: the
    caller zips the results back onto the targets it built them from, so a
    reordering bug would mislabel every finding in the report.

    No ``return_exceptions=True``. The collect layer wraps every read into a
    ``Fetched``, so anything that still escapes here is a genuine bug and
    aborting loudly is the correct response (tripl-ey6j.2).
    """
    semaphore = asyncio.Semaphore(limit)

    async def _guarded(awaitable: Awaitable[T]) -> T:
        async with semaphore:
            return await awaitable

    return list(await asyncio.gather(*(_guarded(item) for item in awaitables)))
