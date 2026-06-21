"""Mapping from human-friendly interval codes to ClickHouse INTERVAL syntax and timedelta."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta


@dataclass(frozen=True)
class IntervalSpec:
    code: str
    ch_interval: str  # ClickHouse INTERVAL clause, e.g. "1 HOUR"
    delta: timedelta
    label: str  # human-readable label


INTERVALS: dict[str, IntervalSpec] = {
    "15m": IntervalSpec("15m", "15 MINUTE", timedelta(minutes=15), "Every 15 min"),
    "1h": IntervalSpec("1h", "1 HOUR", timedelta(hours=1), "Every hour"),
    "6h": IntervalSpec("6h", "6 HOUR", timedelta(hours=6), "Every 6 hours"),
    "1d": IntervalSpec("1d", "1 DAY", timedelta(days=1), "Every day"),
    "1w": IntervalSpec("1w", "1 WEEK", timedelta(weeks=1), "Every week"),
}


def get_interval(code: str) -> IntervalSpec:
    """Get interval spec by code, raising ValueError for unknown codes."""
    spec = INTERVALS.get(code)
    if spec is None:
        msg = f"Unknown interval code: {code!r}. Valid: {', '.join(INTERVALS)}"
        raise ValueError(msg)
    return spec
