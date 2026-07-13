"""Dialect-neutral interval codes shared by every warehouse adapter.

An interval is identified by its *code* (``"15m"``, ``"1h"``, ``"6h"``, ``"1d"``,
``"1w"``). Callers pass the code; each adapter translates it into its own dialect.
Nothing outside :mod:`tripl.core.adapters.clickhouse` should think in ClickHouse
``INTERVAL`` syntax — see :mod:`tripl.core.bucketing` for the bucket contract every
translation must honor.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from enum import StrEnum


class IntervalUnit(StrEnum):
    """The calendar unit an interval is expressed in."""

    minute = "minute"
    hour = "hour"
    day = "day"
    week = "week"


@dataclass(frozen=True)
class IntervalSpec:
    code: str
    unit: IntervalUnit
    count: int
    delta: timedelta
    label: str  # human-readable label


INTERVALS: dict[str, IntervalSpec] = {
    "15m": IntervalSpec("15m", IntervalUnit.minute, 15, timedelta(minutes=15), "Every 15 min"),
    "1h": IntervalSpec("1h", IntervalUnit.hour, 1, timedelta(hours=1), "Every hour"),
    "6h": IntervalSpec("6h", IntervalUnit.hour, 6, timedelta(hours=6), "Every 6 hours"),
    "1d": IntervalSpec("1d", IntervalUnit.day, 1, timedelta(days=1), "Every day"),
    "1w": IntervalSpec("1w", IntervalUnit.week, 1, timedelta(weeks=1), "Every week"),
}


def get_interval(code: str) -> IntervalSpec:
    """Get interval spec by code, raising ValueError for unknown codes."""
    spec = INTERVALS.get(code)
    if spec is None:
        msg = f"Unknown interval code: {code!r}. Valid: {', '.join(INTERVALS)}"
        raise ValueError(msg)
    return spec
