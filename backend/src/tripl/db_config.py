"""Shared SQLAlchemy connection-pool configuration.

Three engine-creation sites in this codebase share the same pool tuning. This
module is the single source of truth for those parameters so they cannot drift
apart. The three engines differ only in their *pooling strategy*, which is
driven by where they run:

- **async (API)** — ``tripl.database``: the FastAPI process is a single
  long-lived event loop, so a real pooled ``QueuePool`` (these constants) is
  the right fit.
- **sync (Celery)** — ``tripl.worker.db``: each Celery prefork worker is a
  long-lived process that checks out a session per task, so it also uses a
  real pooled engine with these same constants.
- **async + NullPool (worker bridge)** — ``tripl.worker.search_reindex``:
  reached from a Celery task via a fresh ``asyncio.run()`` per invocation.
  asyncpg binds connections to the loop that opened them, so a pooled engine
  would hand a later loop a connection from an already-closed loop. That site
  deliberately uses ``NullPool`` instead of these pool-size constants and
  disposes the engine before the loop closes; see the comment there.
"""

from __future__ import annotations

# Base size of the connection pool kept open per engine.
POOL_SIZE = 5

# Additional connections allowed beyond POOL_SIZE under load.
MAX_OVERFLOW = 10

# Test connections for liveness on checkout to avoid handing out stale ones.
POOL_PRE_PING = True

# Recycle connections older than this many seconds to dodge server-side timeouts.
POOL_RECYCLE_SECONDS = 1800
