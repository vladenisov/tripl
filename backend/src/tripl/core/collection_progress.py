"""How far a metric's source grid has actually been collected.

Three places need this answer and MUST agree on it: the scheduler deciding
whether a metric is due, the worker resolving the window to resume from, and the
API reporting ``next_collection_at`` / ``collection_due``. Were they to disagree,
a metric could look due forever, or resume from the wrong point while the UI
claimed it was current. They all read it from here.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from tripl.core.bucketing import to_utc


def collection_progress_to(
    *,
    last_bucket: datetime | None,
    watermark: datetime | None,
    delta: timedelta,
) -> datetime | None:
    """Exclusive upper bound of the source grid a metric has already collected.

    Two independent signals carry that progress, and the later one wins:

    * the last stored bucket, whose exclusive end is the bucket plus one interval;
    * ``last_collection_window_to`` — the watermark a successful collection leaves
      behind even when it returned NO rows. Without it such a metric would look
      permanently un-collected and be re-dispatched on every scheduler tick.

    ``None`` means the metric has never been collected: callers read that as "due
    now", and the worker falls back to its default backfill.
    """
    value_progress_to = to_utc(last_bucket) + delta if last_bucket is not None else None
    watermark_to = to_utc(watermark) if watermark is not None else None
    return max(
        (candidate for candidate in (value_progress_to, watermark_to) if candidate is not None),
        default=None,
    )
