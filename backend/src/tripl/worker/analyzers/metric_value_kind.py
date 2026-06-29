"""Shared value-kind classifier for catalog metric series.

A catalog metric's per-bucket value is either *count-shaped* (a non-negative
volume where a missing bucket genuinely means "zero happened" and a low expected
count is noise) or *fractional* (a ratio / average / arbitrary level where a
missing bucket means "no data" — NOT zero — and small values are meaningful).

This single predicate is consumed by two places that must agree:

* ``worker/tasks/metrics/detect.py`` — count-shaped series are zero-filled and
  gated by ``min_expected_count``; fractional series are neither, so sparse
  ratio buckets do not masquerade as drops to zero / false anomalies.
* ``services/metric_series_service.py`` — count-shaped gaps densify to ``0.0``;
  fractional gaps stay absent (rendered as a null break in the chart).

Count-shaped:  ``fact_aggregation`` with aggregation in {count, count_distinct,
sum}; ``event_composition`` ``single`` (a count).
Fractional:    ``event_composition`` ``ratio`` / ``per_distinct_user``;
``fact_aggregation`` ``avg`` / ``min`` / ``max`` (levels); any ``sql`` metric
(arbitrary user expression).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricKind,
)

if TYPE_CHECKING:
    from tripl.models.metric_definition import MetricDefinition

_COUNT_SHAPED_AGGREGATIONS = {
    MetricAggregation.count,
    MetricAggregation.count_distinct,
    MetricAggregation.sum,
}


def _coerce(value: object, enum_cls: type) -> object:
    """Return ``value`` as ``enum_cls`` (StrEnum), accepting raw strings too."""
    if value is None or isinstance(value, enum_cls):
        return value
    try:
        return enum_cls(value)
    except ValueError:
        return None


def is_count_shaped(metric: MetricDefinition) -> bool:
    """Whether a metric's series is count-shaped (zero-fillable / gate-able).

    Defaults to ``True`` (the safe, count-like behavior) for anything the rules
    below do not explicitly classify as fractional.
    """
    kind = _coerce(metric.kind, MetricKind)
    if kind is MetricKind.sql:
        return False
    if kind is MetricKind.event_composition:
        composition = _coerce(metric.composition, MetricComposition)
        return composition is MetricComposition.single
    if kind is MetricKind.fact_aggregation:
        aggregation = _coerce(metric.aggregation, MetricAggregation)
        return aggregation in _COUNT_SHAPED_AGGREGATIONS
    return True
