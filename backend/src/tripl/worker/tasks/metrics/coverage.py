"""Which buckets a scan config's collection actually covered.

Lifted out of ``tasks.py`` when a second caller appeared: the catalog-metric
detection pass resolves coverage PER METRIC, from the scan config whose grid the
metric's values were collected on — which is not necessarily the config the
running scan belongs to (see
``detect._recalculate_project_metric_anomalies``).

Pure leaf (models + the timestamp helper) so both the orchestrator and the
detector import it without a cycle.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.models.event_metric import EventMetric
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.worker.tasks.metrics._helpers import _parse_task_datetime


def _aligned_with(value: datetime, like: datetime) -> datetime:
    """``value`` re-expressed with the same tz-awareness as ``like``.

    Recorded job windows are parsed to aware UTC, while a window or horizon
    derived from a stored bucket arrives naive on a backend without timezone
    support (SQLite). The two cannot be compared directly, and the floor below
    has to compare against both.
    """
    if (value.tzinfo is None) == (like.tzinfo is None):
        return value
    if like.tzinfo is None:
        return value.astimezone(UTC).replace(tzinfo=None)
    return value.replace(tzinfo=UTC)


def covered_buckets_from_scan_jobs(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    delta: timedelta,
    history_from: datetime,
    current_window: tuple[datetime, datetime] | None = None,
    presence_before: datetime | None = None,
) -> set[datetime]:
    """Buckets a successful collection actually covered, on the interval grid.

    A collection gap (an interval that a failed/never-run job left uncollected)
    is otherwise zero-filled by the detector and masquerades as a 'drop'
    anomaly. We union the ``[time_from, time_to)`` windows of every COMPLETED
    scan job (recorded in ``result_summary``) with the window this run just
    wrote, and hand the enumerated set to ``detect_anomalies`` as
    ``covered_buckets`` so a MISSING bucket is only zero-filled when it fell
    inside real coverage; missing-and-uncovered buckets are excluded instead of
    read as zeros.

    Every bucket that already carries stored data is unioned in as well: data
    only exists because a collection produced it, so a present observation is by
    definition covered. This keeps the baseline intact even for buckets whose
    originating job window is no longer recorded, and never marks a genuine gap
    (which has no row) as covered.

    ``history_from`` bounds the whole computation to the oldest bucket the
    caller's detector pass can consult, and is REQUIRED: both reads are over a
    config's entire lifetime otherwise (an hourly config a year old carries
    ~8,800 completed jobs, and the ``event_metrics`` DISTINCT is one row per
    event per bucket on top of that), while ``expand_series`` starts at the
    oldest point the pass loaded and never tests a bucket below its own
    ``history_from``. The bound must stay TIME-based: a recent-N row limit would
    leave every older bucket uncovered, and an uncovered bucket is EXCLUDED from
    the series rather than zero-filled, so genuinely-zero buckets would silently
    drop out of every baseline.

    ``current_window`` is the window the caller's run just wrote, unioned in
    because a bucket the scan observed as zero has no stored row and no
    completed job summary yet. It is absent when the caller is asking about a
    FOREIGN config, which this run wrote nothing for; ``presence_before`` then
    supplies the upper bound for the stored-bucket read.
    """
    if presence_before is not None:
        present_before = presence_before
    elif current_window is not None:
        present_before = current_window[1]
    else:
        msg = "covered_buckets_from_scan_jobs needs current_window or presence_before"
        raise ValueError(msg)

    windows: list[tuple[datetime, datetime]] = []
    if current_window is not None:
        windows.append(current_window)
    summaries = session.execute(
        select(ScanJob.result_summary).where(
            ScanJob.scan_config_id == scan_config_id,
            ScanJob.status == ScanJobStatus.completed.value,
            ScanJob.created_at >= history_from,
        )
    ).scalars()
    for summary in summaries:
        if not isinstance(summary, dict):
            continue
        raw_from = summary.get("time_from")
        raw_to = summary.get("time_to")
        if not isinstance(raw_from, str) or not isinstance(raw_to, str):
            continue
        try:
            window_from = _parse_task_datetime(raw_from)
            window_to = _parse_task_datetime(raw_to)
        # result_summary is free-form JSON, so a recorded bound can be malformed
        # (ValueError) or not a string at all (TypeError).
        except ValueError, TypeError:
            continue
        if window_from < window_to:
            windows.append((window_from, window_to))

    covered: set[datetime] = set()
    for window_from, window_to in windows:
        bucket = window_from
        # The ``created_at`` filter above does not bound this loop on its own: a
        # replay job has a recent created_at and a multi-year recorded window.
        # Advance in whole ``delta`` steps so every emitted bucket stays on the
        # grid the unbounded loop produced; the horizon itself need not sit on
        # that grid (the slack is a flat day, a weekly grid is not), so round the
        # step count UP rather than letting floor division land below it.
        floor = _aligned_with(history_from, bucket)
        if bucket < floor:
            steps = (floor - bucket) // delta
            if bucket + delta * steps < floor:
                steps += 1
            bucket += delta * steps
        while bucket < window_to:
            covered.add(bucket)
            bucket += delta

    present_buckets = session.execute(
        select(EventMetric.bucket)
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.bucket >= history_from,
            EventMetric.bucket < present_before,
        )
        .distinct()
    ).scalars()
    covered.update(bucket for bucket in present_buckets if bucket is not None)
    return covered
