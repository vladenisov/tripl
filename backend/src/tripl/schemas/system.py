"""Instance-level health surfaced to the UI (not project-scoped)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

WorkerHealthState = Literal["ok", "stale", "never", "unknown"]


class WorkerHealth(BaseModel):
    """Liveness of the async pipeline (celery-beat + celery-worker together).

    ``unknown`` is a first-class state, not an error: with Redis disabled there
    is nowhere to keep the heartbeat, so the honest answer is "cannot tell"
    rather than a false alarm.
    """

    state: WorkerHealthState = Field(
        description=(
            "ok — a heartbeat landed recently; stale — the last one is older than "
            "stale_after_seconds; never — no heartbeat has ever been seen; "
            "unknown — liveness cannot be determined (Redis is off or unreachable)."
        )
    )
    last_heartbeat_at: datetime | None = Field(
        default=None,
        description="When the pipeline last proved itself alive; null for never/unknown.",
    )
    stale_after_seconds: int = Field(
        description="Silence beyond this many seconds is reported as stale.",
    )
