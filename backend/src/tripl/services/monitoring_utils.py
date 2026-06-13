from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

RECENT_SIGNAL_WINDOW = timedelta(hours=24)


def classify_signal_state(
    *,
    anomaly_bucket: datetime,
    latest_metric_bucket: datetime | None,
) -> str | None:
    if latest_metric_bucket is None or anomaly_bucket >= latest_metric_bucket:
        return "latest_scan"

    recent_cutoff = datetime.now(UTC)
    if anomaly_bucket.tzinfo is None:
        recent_cutoff = recent_cutoff.replace(tzinfo=None)
    recent_cutoff -= RECENT_SIGNAL_WINDOW
    if anomaly_bucket >= recent_cutoff:
        return "recent"

    return None


def _bucket_is_recent(bucket: datetime, cutoff: datetime) -> bool:
    """Compare a (possibly tz-naive) anomaly bucket against an aware cutoff.

    Mirrors ``classify_signal_state``'s handling so naive timestamps coming
    back from the DB don't raise on aware/naive comparison.
    """
    if bucket.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=None)
    return bucket >= cutoff


class _MonitorState(Protocol):
    is_active: bool
    last_anomaly_bucket: datetime | None
    last_notified_at: datetime | None


@dataclass(frozen=True)
class MonitorRollup:
    status: str  # "firing" | "warning" | "healthy"
    active_scope_count: int
    firing_scope_count: int
    last_anomaly_at: datetime | None
    last_notified_at: datetime | None


def summarize_monitor_states(
    states: Sequence[_MonitorState],
    *,
    now: datetime,
) -> MonitorRollup:
    """Roll a rule's per-scope alert states into a single monitor status.

    * firing  — at least one active scope with an anomaly inside the recent window
    * warning — active scopes exist, but none have a recent anomaly (stale/open)
    * healthy — no active scopes
    """
    firing_cutoff = now - RECENT_SIGNAL_WINDOW
    active = [state for state in states if state.is_active]
    firing = [
        state
        for state in active
        if state.last_anomaly_bucket is not None
        and _bucket_is_recent(state.last_anomaly_bucket, firing_cutoff)
    ]
    if firing:
        status = "firing"
    elif active:
        status = "warning"
    else:
        status = "healthy"

    last_anomaly_at = max(
        (state.last_anomaly_bucket for state in states if state.last_anomaly_bucket is not None),
        default=None,
    )
    last_notified_at = max(
        (state.last_notified_at for state in states if state.last_notified_at is not None),
        default=None,
    )
    return MonitorRollup(
        status=status,
        active_scope_count=len(active),
        firing_scope_count=len(firing),
        last_anomaly_at=last_anomaly_at,
        last_notified_at=last_notified_at,
    )
