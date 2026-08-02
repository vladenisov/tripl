"""Is the async pipeline actually turning?

The API serves requests happily with celery-worker and celery-beat both dead —
scans, metric collection, anomaly detection and alert delivery simply never
run, and nothing in the UI says so. This reads the heartbeat those two
processes leave behind and classifies it.

The one rule worth stating: never claim health that has not been proven. When
the heartbeat cannot be read at all, the answer is ``unknown``, never ``ok``.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from tripl import cache
from tripl.schemas.system import WorkerHealth, WorkerHealthState

logger = logging.getLogger(__name__)

# Matches the beat interval in worker/celery_app.py.
WORKER_HEARTBEAT_INTERVAL_SECONDS = 60
# Three missed beats before crying wolf: one skipped tick is normal under load,
# three in a row is not.
WORKER_HEARTBEAT_STALE_SECONDS = 3 * WORKER_HEARTBEAT_INTERVAL_SECONDS


async def get_worker_health() -> WorkerHealth:
    """Classify the pipeline's liveness from its last heartbeat."""
    client = cache.get_async_client()
    if client is None:
        # Redis off — the heartbeat has nowhere to live, so liveness is genuinely
        # unknowable here rather than bad.
        return _health("unknown")

    try:
        raw = await client.get(cache.key_worker_heartbeat())
    except Exception:
        # A cache outage says nothing about the worker itself.
        logger.warning("Could not read the worker heartbeat", exc_info=True)
        return _health("unknown")

    if raw is None:
        return _health("never")

    stamp = _parse(raw)
    if stamp is None:
        logger.warning("Worker heartbeat holds an unparseable value: %r", raw)
        return _health("unknown")

    age = (datetime.now(UTC) - stamp).total_seconds()
    return _health("stale" if age > WORKER_HEARTBEAT_STALE_SECONDS else "ok", stamp)


def _health(state: WorkerHealthState, last: datetime | None = None) -> WorkerHealth:
    return WorkerHealth(
        state=state,
        last_heartbeat_at=last,
        stale_after_seconds=WORKER_HEARTBEAT_STALE_SECONDS,
    )


def _parse(raw: str | bytes) -> datetime | None:
    text = raw.decode() if isinstance(raw, bytes) else raw
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        return None
    # A naive stamp would make the age arithmetic above raise.
    return stamp if stamp.tzinfo is not None else stamp.replace(tzinfo=UTC)
