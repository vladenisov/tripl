"""Per-anomaly context helpers for alert rendering (sparkline + top movers).

These run at delivery-send time (not at enqueue) so the data is always
fresh and we don't need to persist extra columns on AlertDeliveryItem.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from tripl.models.event_metric import EventMetric
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly

SCOPE_PROJECT_TOTAL = "project_total"
SCOPE_EVENT_TYPE = "event_type"
SCOPE_EVENT = "event"

_SPARK_BLOCKS = "▁▂▃▄▅▆▇█"
SPARKLINE_WIDTH = 24
TOP_MOVERS_LIMIT = 3
_MAX_MOVER_VALUE_LEN = 24


def build_sparkline(values: Iterable[float | int], width: int = SPARKLINE_WIDTH) -> str:
    """Render an 8-level unicode sparkline. Empty input → empty string."""
    points = [float(v) for v in values]
    if not points:
        return ""
    # Keep only the most recent `width` buckets.
    if len(points) > width:
        points = points[-width:]
    lo = min(points)
    hi = max(points)
    if hi == lo:
        # All identical → render mid-level so receivers see "no change".
        return _SPARK_BLOCKS[len(_SPARK_BLOCKS) // 2] * len(points)
    span = hi - lo
    chars: list[str] = []
    for value in points:
        idx = int((value - lo) / span * (len(_SPARK_BLOCKS) - 1))
        chars.append(_SPARK_BLOCKS[max(0, min(len(_SPARK_BLOCKS) - 1, idx))])
    return "".join(chars)


def _percent_signed(actual: int, expected: float) -> str:
    """+320% / -75% / inf% style label, always rounded to integer."""
    if expected <= 0:
        return "+inf%" if actual > 0 else "0%"
    delta = (actual - expected) / expected * 100
    sign = "+" if delta >= 0 else "−"
    return f"{sign}{abs(delta):.0f}%"


def format_top_movers(movers: list[MetricBreakdownAnomaly]) -> str:
    """Human-readable inline summary: 'country=RU +320% · device=mobile −80%'."""
    parts: list[str] = []
    for mover in movers:
        value = mover.breakdown_value or ""
        if len(value) > _MAX_MOVER_VALUE_LEN:
            value = value[: _MAX_MOVER_VALUE_LEN - 1] + "…"
        parts.append(
            f"{mover.breakdown_column}={value} "
            f"{_percent_signed(mover.actual_count, mover.expected_count)}"
        )
    return " · ".join(parts)


def load_top_movers(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    bucket: datetime,
    limit: int = TOP_MOVERS_LIMIT,
) -> list[MetricBreakdownAnomaly]:
    """Return the breakdown anomalies that moved hardest at this scope+bucket."""
    return list(
        session.execute(
            select(MetricBreakdownAnomaly)
            .where(
                MetricBreakdownAnomaly.scan_config_id == scan_config_id,
                MetricBreakdownAnomaly.scope_type == scope_type,
                MetricBreakdownAnomaly.scope_ref == scope_ref,
                MetricBreakdownAnomaly.bucket == bucket,
            )
            .order_by(desc(func.abs(MetricBreakdownAnomaly.z_score)))
            .limit(limit)
        )
        .scalars()
        .all()
    )


def load_recent_metric_points(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    until: datetime,
    width: int = SPARKLINE_WIDTH,
) -> list[int]:
    """Last `width` bucket counts for the scope, ending at `until`."""
    if scope_type == SCOPE_PROJECT_TOTAL:
        query = (
            select(EventMetric.bucket, func.sum(EventMetric.count))
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id.is_not(None),
                EventMetric.bucket <= until,
            )
            .group_by(EventMetric.bucket)
            .order_by(EventMetric.bucket.desc())
            .limit(width)
        )
    elif scope_type == SCOPE_EVENT_TYPE:
        try:
            event_type_id = uuid.UUID(scope_ref)
        except ValueError:
            return []
        query = (
            select(EventMetric.bucket, EventMetric.count)
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id == event_type_id,
                EventMetric.bucket <= until,
            )
            .order_by(EventMetric.bucket.desc())
            .limit(width)
        )
    else:
        try:
            event_id = uuid.UUID(scope_ref)
        except ValueError:
            return []
        query = (
            select(EventMetric.bucket, EventMetric.count)
            .where(
                EventMetric.scan_config_id == scan_config_id,
                EventMetric.event_id == event_id,
                EventMetric.bucket <= until,
            )
            .order_by(EventMetric.bucket.desc())
            .limit(width)
        )

    rows = session.execute(query).all()
    # Restore chronological order (oldest → newest) for the sparkline.
    return [int(count) for _bucket, count in reversed(rows)]


def build_alert_item_context(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    bucket: datetime,
) -> tuple[str, str]:
    """Return (sparkline, top_movers_text) for a single alert item.

    Both reads run inside ``session.no_autoflush`` so the surrounding render
    pipeline (which may have pending writes on ``delivery.payload_snapshot``)
    isn't autoflushed mid-build — that flush would lock in the JSON column
    against later in-place mutations of the same dict.
    """
    with session.no_autoflush:
        movers = load_top_movers(
            session,
            scan_config_id=scan_config_id,
            scope_type=scope_type,
            scope_ref=scope_ref,
            bucket=bucket,
        )
        sparkline_points = load_recent_metric_points(
            session,
            scan_config_id=scan_config_id,
            scope_type=scope_type,
            scope_ref=scope_ref,
            until=bucket,
        )
    return build_sparkline(sparkline_points), format_top_movers(movers)
