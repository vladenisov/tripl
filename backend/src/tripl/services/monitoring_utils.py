from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

RECENT_SIGNAL_WINDOW = timedelta(hours=24)

# A "latest_scan" (open) signal is only fresh while its anomaly bucket sits within
# this many scan intervals of ``now``. Without a wall-clock cap, a scan that stops
# collecting leaves its final anomaly pinned at ``max(bucket)`` forever, so it would
# classify as ``latest_scan`` indefinitely (week-old anomalies staying red while the
# charts are empty). The horizon is floored at ``RECENT_SIGNAL_WINDOW`` so sub-daily
# scans are never bounded tighter than 24h.
LATEST_SCAN_STALE_INTERVALS = 3

# ScanInterval enum string (e.g. "1d") -> wall-clock duration. Keyed by string so
# this module stays a pure leaf (no model/enum import); callers pass config.interval.
_SCAN_INTERVAL_DELTAS: dict[str, timedelta] = {
    "15m": timedelta(minutes=15),
    "1h": timedelta(hours=1),
    "6h": timedelta(hours=6),
    "1d": timedelta(days=1),
    "1w": timedelta(weeks=1),
}


def scan_interval_to_timedelta(interval: str | None) -> timedelta | None:
    """Map a ScanInterval value (e.g. ``"1d"``) to a ``timedelta``.

    Returns ``None`` for an unknown/absent interval so ``classify_signal_state``
    falls back to the default ``RECENT_SIGNAL_WINDOW`` freshness horizon.
    """
    if interval is None:
        return None
    return _SCAN_INTERVAL_DELTAS.get(str(interval))


def _latest_scan_horizon(interval: timedelta | None) -> timedelta:
    if interval is None:
        return RECENT_SIGNAL_WINDOW
    return max(RECENT_SIGNAL_WINDOW, LATEST_SCAN_STALE_INTERVALS * interval)


def classify_signal_state(
    *,
    anomaly_bucket: datetime,
    latest_metric_bucket: datetime | None,
    now: datetime | None = None,
    interval: timedelta | None = None,
) -> str | None:
    # No stored metric values means there is no live scan to anchor recency on, so
    # there is nothing to keep open — treat the signal as closed.
    if latest_metric_bucket is None:
        return None

    reference = now if now is not None else datetime.now(UTC)

    if anomaly_bucket >= latest_metric_bucket:
        latest_scan_cutoff = reference - _latest_scan_horizon(interval)
        if _bucket_is_recent(anomaly_bucket, latest_scan_cutoff):
            return "latest_scan"
        # A stopped scan's final anomaly still tops max(bucket) but is stale in
        # wall-clock terms; fall through to the recent-window / closed checks.

    recent_cutoff = reference - RECENT_SIGNAL_WINDOW
    if _bucket_is_recent(anomaly_bucket, recent_cutoff):
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
