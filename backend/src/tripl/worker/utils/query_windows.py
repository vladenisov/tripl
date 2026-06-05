from __future__ import annotations

from datetime import UTC, datetime, timedelta

TimeWindow = tuple[datetime, datetime]


def resolve_lookback_window(
    *,
    time_column: str | None,
    lookback_hours: int | None,
    end: datetime | None = None,
) -> TimeWindow | None:
    if not time_column or lookback_hours is None:
        return None
    window_end = end or datetime.now(UTC)
    if window_end.tzinfo is None:
        window_end = window_end.replace(tzinfo=UTC)
    else:
        window_end = window_end.astimezone(UTC)
    return window_end - timedelta(hours=lookback_hours), window_end
