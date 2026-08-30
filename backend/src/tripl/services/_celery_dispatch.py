"""Publish Celery messages without blocking the request event loop.

Every dispatch on the API side happens inside an ``async def`` handler, and a
kombu publish is synchronous socket I/O: against a hung broker it holds the
thread for seconds (see the bounds set in ``worker/celery_app.py``). Done
directly, that freezes the whole uvicorn worker — every concurrent request on
it, health checks included — not just the caller. The rest of this codebase
already routes blocking I/O through ``asyncio.to_thread`` (warehouse adapters,
SMTP, photo storage); broker publishes were the family that was missed.

Worker-side publishes are a different case: a Celery task body is synchronous
by design and must keep calling ``.delay()`` directly.
"""

import asyncio
from collections.abc import Callable
from typing import Any


async def dispatch(send: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    """Run one blocking kombu publish in a worker thread.

    ``send`` is an already-bound ``task.delay`` or ``celery_app.send_task``.
    Exceptions propagate to the awaiting caller unchanged, so the ``try/except``
    blocks that already surround these publishes keep working as before.
    """
    return await asyncio.to_thread(send, *args, **kwargs)
