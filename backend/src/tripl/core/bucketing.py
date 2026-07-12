"""The canonical time-window and bucket contract for every warehouse adapter.

This module is the reference implementation. ClickHouse, BigQuery, PostgreSQL and
the synthetic adapter each translate an interval code into their own dialect, and
every translation must agree with :func:`floor_to_bucket` for the same UTC input.
The conformance suite asserts exactly that, so the rules below are executable, not
aspirational.

The contract
------------
**Everything is UTC.** A naive ``datetime`` is *assumed* to already be UTC; an
aware one is converted. Adapters must pin the session/column timezone to UTC
rather than inheriting the server's, so a warehouse running in a non-UTC timezone
cannot shift a bucket.

**Windows are half-open**: ``time_from <= t < time_to``. A row exactly on
``time_to`` belongs to the next window, so adjacent windows tile without
double-counting a boundary row.

**Sub-week buckets are anchored at the Unix epoch** (1970-01-01T00:00:00Z). 15m,
1h, 6h and 1d all divide a UTC day evenly, so an epoch anchor also puts every
bucket boundary on a natural clock boundary.

**Week buckets start on Monday**, anchored at :data:`WEEK_ORIGIN`
(1970-01-05T00:00:00Z, the first Monday of the epoch).

The dialects do *not* agree here by default, and they disagree in different ways,
so each adapter states "Monday" explicitly rather than trusting its default:

* A plain 7-day bin measured from the epoch starts weeks on a **Thursday**, because
  1970-01-01 was a Thursday. That is what PostgreSQL's ``date_bin`` and BigQuery's
  ``*_BUCKET`` do if handed the epoch as the origin, so those two adapters pass
  :data:`WEEK_ORIGIN` / use ``*_TRUNC(..., WEEK(MONDAY))`` instead.
* ClickHouse's ``toStartOfInterval(col, INTERVAL 1 WEEK)`` is the exception: it is
  *already* Monday-aligned on :data:`WEEK_ORIGIN`, verified against a live server.
  It nonetheless returns a ``Date`` rather than a ``DateTime``, so a 1w bucket would
  come back as ``datetime.date`` while every other interval yields
  ``datetime.datetime``. The adapter uses ``toDateTime(toMonday(...))`` to keep the
  bucket type consistent across all five intervals, not to fix the origin.

There is no DST hazard anywhere in here *because* the contract is UTC-only: UTC
has no DST transitions, so a fixed-width bin never straddles a clock change.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from tripl.core.intervals import IntervalUnit, get_interval

#: Anchor for every sub-week bucket.
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

#: Anchor for week buckets: the first Monday at or after the epoch. 1970-01-01 was
#: a Thursday, so binning weeks straight off :data:`EPOCH` would start weeks on a
#: Thursday. Weeks start on Monday.
WEEK_ORIGIN = datetime(1970, 1, 5, tzinfo=UTC)


def to_utc(value: datetime) -> datetime:
    """Normalize a datetime to an aware UTC datetime.

    A naive datetime is *assumed* to be UTC and is stamped as such rather than
    being interpreted in the host's local timezone — the worker's TZ must never
    change which bucket a row lands in.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def bucket_origin(interval_code: str) -> datetime:
    """The anchor a given interval's buckets are measured from."""
    spec = get_interval(interval_code)
    return WEEK_ORIGIN if spec.unit is IntervalUnit.week else EPOCH


def floor_to_bucket(value: datetime, interval_code: str) -> datetime:
    """Floor a timestamp to the start of its bucket, in UTC.

    This is the definition every adapter's generated SQL is measured against.
    """
    spec = get_interval(interval_code)
    moment = to_utc(value)
    origin = bucket_origin(interval_code)
    elapsed: timedelta = moment - origin
    return origin + (elapsed // spec.delta) * spec.delta


def format_utc_literal(value: datetime) -> str:
    """Render a UTC timestamp for embedding in warehouse SQL.

    Includes the explicit ``+00:00`` offset: an offset-less literal is read in the
    session timezone by some dialects, which is exactly the window shift this
    contract exists to prevent. Microseconds are preserved so a half-open window
    bound cannot silently swallow or drop a sub-second row.
    """
    return to_utc(value).strftime("%Y-%m-%d %H:%M:%S.%f+00:00")
