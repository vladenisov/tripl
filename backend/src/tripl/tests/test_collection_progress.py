"""The single progress rule the scheduler, the worker and the API all read.

Each of them used to recompute it. This pins the contract they now share: how far
a metric's source grid has been collected, given the last stored bucket and the
watermark a successful collection leaves behind.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from tripl.core.collection_progress import collection_progress_to

HOUR = timedelta(hours=1)
BUCKET = datetime(2026, 1, 1, 10, tzinfo=UTC)


def test_never_collected_metric_has_no_progress() -> None:
    assert collection_progress_to(last_bucket=None, watermark=None, delta=HOUR) is None


def test_last_bucket_progress_is_exclusive_of_the_bucket_itself() -> None:
    # A stored 10:00 bucket on a 1h grid means the grid is done up to 11:00.
    progress = collection_progress_to(last_bucket=BUCKET, watermark=None, delta=HOUR)

    assert progress == BUCKET + HOUR


def test_watermark_carries_progress_no_bucket_was_left_for() -> None:
    """A successful collection that returned no rows still moved the source grid.

    Without the watermark such a metric looks permanently un-collected and is
    re-dispatched on every scheduler tick.
    """
    watermark = BUCKET + timedelta(hours=5)

    progress = collection_progress_to(last_bucket=None, watermark=watermark, delta=HOUR)

    assert progress == watermark


def test_the_later_of_bucket_and_watermark_wins() -> None:
    ahead = BUCKET + timedelta(hours=5)

    assert collection_progress_to(last_bucket=BUCKET, watermark=ahead, delta=HOUR) == ahead
    # A watermark left by an older collection never drags progress backwards.
    assert (
        collection_progress_to(last_bucket=BUCKET, watermark=BUCKET - HOUR, delta=HOUR)
        == BUCKET + HOUR
    )


def test_naive_datetimes_are_read_as_utc() -> None:
    """SQLite drops tzinfo on round-trip, so either input can come back naive."""
    naive_bucket = BUCKET.replace(tzinfo=None)

    assert collection_progress_to(last_bucket=naive_bucket, watermark=None, delta=HOUR) == (
        BUCKET + HOUR
    )
