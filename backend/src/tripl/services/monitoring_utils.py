from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
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
# the configured window and only long grids move. ``worker.tasks.metrics.signals``
# IMPORTS this rather than keeping its own copy: it used to mirror it, and the
# mirror drifted twice (tripl-l429.14, tripl-l429.19). ``test_monitors_summary``
# pins the two as the same object, not merely as equal values — equality is what
# a fresh copy also satisfies on the day it is written.
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


def scan_liveness_cutoff(
    *,
    interval: str | None,
    recent_window: timedelta | None,
    now: datetime | None = None,
) -> datetime:
    """Oldest bucket that can still prove a collector is alive.

    Callers that must ASK the database for a scan's newest bucket (rather than
    deriving it from rows they already hold) use this to bound the query: a
    bucket older than this cutoff would fail ``_bucket_is_recent`` inside
    ``_outage_is_still_running`` anyway, so filtering it out in SQL discards
    nothing and keeps the read off an unbounded ``event_metrics`` scan. Derived
    from the same horizon rule as the classification itself, because a probe
    measured against a different window than the decision it feeds is exactly
    how the two signal paths drifted before.
    """
    reference = now if now is not None else datetime.now(UTC)
    window = recent_window if recent_window is not None else RECENT_SIGNAL_WINDOW
    return reference - _freshness_horizon(scan_interval_to_timedelta(interval), window)


def latest_bucket_by_scan(
    rows: Iterable[tuple[uuid.UUID | None, datetime | None]],
) -> dict[uuid.UUID, datetime]:
    """Newest bucket collected per scan config — the "is this collector alive" probe.

    Fed to ``classify_signal_state``'s ``scan_latest_bucket``. Shared because the
    Anomalies page and the sidebar badge read it out of differently-shaped
    metric-bucket maps, and those surfaces only agree while both derive scan
    liveness by literally the same rule. Taking the max across every scope of a
    scan (not just its project total) keeps the probe honest on a scan whose
    per-event rows run ahead of its per-type rollup.
    """
    latest: dict[uuid.UUID, datetime] = {}
    for scan_config_id, bucket in rows:
        if scan_config_id is None or bucket is None:
            continue
        current = latest.get(scan_config_id)
        if current is None or bucket > current:
            latest[scan_config_id] = bucket
    return latest


def _outage_is_still_running(
    *,
    anomaly_actual_count: float | None,
    scan_latest_bucket: datetime | None,
    cutoff: datetime,
) -> bool:
    """Whether a persisted outage anchor still describes the CURRENT series.

    Only meaningful from inside ``classify_signal_state``'s
    ``anomaly_bucket >= latest_metric_bucket`` branch, which already establishes
    the second half of the question: the scope has stored nothing newer than the
    anomaly, so it has emitted nothing since. This adds the two facts that turn
    that into "still down":

      * the ANCHOR ROW says the scope was at zero when it was announced
        (``actual_count == 0``). ``_collapse_outage_runs`` gives an outage
        exactly one such row and never re-emits it, so this row is the whole
        announcement — there will not be a fresher one to age against;
      * the SCAN is still collecting something (``scan_latest_bucket`` inside
        the same freshness horizon), so the silence belongs to this scope rather
        than to a collector that stopped. Without it the very cap the
        latest-scan branch exists for would be gone, and a switched-off scan
        would pin its final anomaly red forever.

    Callers that cannot answer both — catalog ``metric`` scopes have no scan to
    ask, and a fractional series' 0.0 is a value rather than "emitted nothing" —
    pass neither and land exactly where they did before. COUNT-shaped,
    scan-backed scopes only, matching ``_collapse_outage_runs``.
    """
    if anomaly_actual_count is None or anomaly_actual_count > 0:
        return False
    if scan_latest_bucket is None:
        return False
    return _bucket_is_recent(scan_latest_bucket, cutoff)


def classify_signal_state(
    *,
    anomaly_bucket: datetime,
    latest_metric_bucket: datetime | None,
    now: datetime | None = None,
    interval: timedelta | None = None,
    recent_window: timedelta | None = None,
    anomaly_actual_count: float | None = None,
    scan_latest_bucket: datetime | None = None,
    emission_lag: timedelta = timedelta(0),
) -> str | None:
    """Classify one anomaly as ``"latest_scan"``, ``"recent"`` or closed (``None``).

    The single classifier for BOTH signal paths — the request path that renders
    the Anomalies page, the badge, the catalog and the drilldown, and the
    worker's alert-candidacy pass in ``worker.tasks.metrics.signals``. It used to
    be two hand-maintained copies, on the stated grounds that the worker must not
    import the services layer; this module imports no ``tripl`` module at all, so
    that never applied, and the copies drifted twice inside one PR
    (tripl-l429.14, tripl-l429.19), each time showing a signal open on the page
    while the alerting path treated it as closed.

    The three optional inputs are the ones only some callers can answer, and each
    defaults to the value that reproduces the behaviour of a caller that cannot:

    * ``emission_lag`` — how far behind the metric head the newest EMITTABLE
      anomaly can sit. Detection withholds the newest ``settling_buckets`` of a
      series from emission, so a scope that is still emitting can never carry an
      anomaly at or after its own head; the alert path measures the head that far
      back so a live scope can reach the latest-scan branch at all. It is exactly
      a shift of the head, i.e. ``emission_lag=L`` answers what
      ``latest_metric_bucket - L`` would. The display path passes nothing, keeping
      the raw head and the classification the API has always rendered;
    * ``anomaly_actual_count`` / ``scan_latest_bucket`` — the outage re-check, see
      ``_outage_is_still_running``. Callers that cannot answer both (a catalog
      metric has no scan to probe, and a fractional series' ``0.0`` is a value
      rather than silence) pass neither and land where they did before.
    """
    # No stored metric values means there is no live scan to anchor recency on, so
    # there is nothing to keep open — treat the signal as closed.
    if latest_metric_bucket is None:
        return None

    reference = now if now is not None else datetime.now(UTC)
    # Absent per-project override, every branch below behaves exactly as it did
    # when the 24h constant was read directly.
    window = recent_window if recent_window is not None else RECENT_SIGNAL_WINDOW
    horizon = _freshness_horizon(interval, window)

    if anomaly_bucket >= latest_metric_bucket - emission_lag:
        latest_scan_cutoff = reference - horizon
        if _bucket_is_recent(anomaly_bucket, latest_scan_cutoff):
            return "latest_scan"
        # An outage that never recovered has no fresher row to be judged on: its
        # anchor was announced once, at onset, and deliberately never re-emitted.
        # Re-check it against the series instead of its own age — the scope's
        # newest data point is still that zero, so the incident is still running
        # and "latest_scan" is still literally true.
        if _outage_is_still_running(
            anomaly_actual_count=anomaly_actual_count,
            scan_latest_bucket=scan_latest_bucket,
            cutoff=latest_scan_cutoff,
        ):
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
