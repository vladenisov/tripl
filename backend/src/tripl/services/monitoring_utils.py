from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

# Default freshness window for an open signal. Projects can override it via
# ProjectAnomalySettings.recent_signal_window_hours, which reaches this module as
# the ``recent_window`` argument below; callers that pass nothing keep this value.
RECENT_SIGNAL_WINDOW = timedelta(hours=24)

# An open signal is only fresh while its anomaly bucket sits within this many
# scan intervals of ``now``. Two things depend on it, and they pull in opposite
# directions:
#
#   * a CAP, so a scan that stops collecting cannot leave its final anomaly —
#     still topping ``max(bucket)`` — classified as open forever, red while the
#     charts are empty;
#   * a FLOOR, so a grid coarser than the wall-clock window is not measured
#     against a window shorter than one of its own buckets.
#
# Both are ``max(recent_window, N * interval)``, so sub-daily scans keep exactly
# the configured window and only long grids move. A duplicate of this constant
# lives in ``worker.tasks.metrics.signals``; ``test_monitors_summary`` pins the
# two together, because nothing did before and the two paths drifted.
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
    falls back to the effective recent window as its freshness horizon.
    """
    if interval is None:
        return None
    return _SCAN_INTERVAL_DELTAS.get(str(interval))


def recent_signal_window_from_hours(hours: int | None) -> timedelta | None:
    """Map a project's configured freshness window (in hours) to a ``timedelta``.

    Returns ``None`` for an absent/unset value so callers can hand the result
    straight to ``classify_signal_state``'s ``recent_window`` and land on the
    default ``RECENT_SIGNAL_WINDOW``. Takes an ``int`` rather than an ORM row so
    this module stays a pure leaf.
    """
    if hours is None:
        return None
    return timedelta(hours=int(hours))


def _freshness_horizon(
    interval: timedelta | None,
    recent_window: timedelta = RECENT_SIGNAL_WINDOW,
) -> timedelta:
    """How long an anomaly bucket keeps a signal open, floored at the series' own grid.

    A wall-clock window shorter than one bucket cannot describe freshness: on a
    daily grid the newest anomaly the detector may emit is already a full bucket
    behind the metric head — ingestion settling withholds the newest bucket from
    emission — so a 24-hour window excludes it and the signal reads as closed
    however large it was. Weekly is worse: 24 hours is a seventh of one bucket.
    Flooring at ``LATEST_SCAN_STALE_INTERVALS`` buckets is inert on every grid up
    to 6h (``max(24h, 18h)`` is still 24h) and only bites where the window was
    narrower than the data it measures.

    It does override a project's own ``recent_signal_window_hours`` on a long
    grid — 6 hours on a daily scan becomes 72 — and that is deliberate: the
    setting exists to age out burned-out spikes sooner, not to hide every signal
    a scan can produce.
    """
    if interval is None:
        return recent_window
    return max(recent_window, LATEST_SCAN_STALE_INTERVALS * interval)


def classify_signal_state(
    *,
    anomaly_bucket: datetime,
    latest_metric_bucket: datetime | None,
    now: datetime | None = None,
    interval: timedelta | None = None,
    recent_window: timedelta | None = None,
) -> str | None:
    # No stored metric values means there is no live scan to anchor recency on, so
    # there is nothing to keep open — treat the signal as closed.
    if latest_metric_bucket is None:
        return None

    reference = now if now is not None else datetime.now(UTC)
    # Absent per-project override, every branch below behaves exactly as it did
    # when the 24h constant was read directly.
    window = recent_window if recent_window is not None else RECENT_SIGNAL_WINDOW
    horizon = _freshness_horizon(interval, window)

    if anomaly_bucket >= latest_metric_bucket:
        latest_scan_cutoff = reference - horizon
        if _bucket_is_recent(anomaly_bucket, latest_scan_cutoff):
            return "latest_scan"
        # A stopped scan's final anomaly still tops max(bucket) but is stale in
        # wall-clock terms; fall through to the recent-window / closed checks.

    # Same horizon as the branch above, and for the same reason. Ingestion
    # settling withholds the newest bucket(s) from EMISSION, so a scope that is
    # still emitting can never carry an anomaly at or after its own metric head
    # — the branch above is unreachable for anything alive, and this one decides
    # every live signal. Measuring it against a bare 24 hours closed every signal
    # on a daily or weekly scan outright, since the newest emittable anomaly
    # there is already a whole bucket old.
    recent_cutoff = reference - horizon
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

    Deliberately NOT narrowed by the project's configured open-signal window:
    this summarizes ALERT state, and alert dispatch stays on the fixed window
    (see ``worker.tasks.metrics.signals._get_latest_active_anomalies``), so a
    monitor must not read "healthy" while its rule is still delivering.
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
