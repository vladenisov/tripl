"""Which catalog metrics take part in monitoring — decided in ONE place.

A catalog metric participates in monitoring when it is BOTH ``active`` AND has
``anomaly_detection_enabled`` set. That conjunction is authoritative for every
surface: detection, alert candidacy, the Anomalies page, the sidebar badge, the
catalog list row and the metric drilldown.

Why the CONJUNCTION, and why the narrow half wins
-------------------------------------------------
Detection (``worker.tasks.metrics.detect._recalculate_project_metric_anomalies``)
always required both halves. Every consumer required only the flag, so detection
was a strict SUBSET of alert candidacy and "detected but never alertable" — the
silence this epic exists to remove — could not arise from ``status`` at all. The
direction that DOES arise is the opposite one, and it is not dead code:

A metric keeps every ``MetricAnomaly`` row it ever had when it leaves ``active``.
Nothing purges them. ``detect._purge_project_metric_anomalies`` runs only when
PROJECT-level detection is switched off; ``detect._age_out_config_anomalies``
matches on ``scan_config_id`` and metric-scope rows carry NULL there;
``metric_definition_service._clear_collected_metric_data`` fires on a DEFINITION
change, not a status change; and the catalog's bulk archive/restore issues a bare
``UPDATE ... SET status``. Collection stops too, so the metric's newest stored
value bucket freezes and its last anomaly keeps testing as the settled head by
construction — only the wall-clock horizon ``max(recent_window, 3 x interval)``
ever closed it.

So for up to three weeks after archiving a ``1w`` metric, its frozen anomaly was
still a live alert candidate that could NEWLY send to Telegram/Slack, and still
read as an open signal on all four display surfaces.

Widening detection to match the consumers is not an option: a metric that has
stopped collecting is zero-filled when it is count-shaped, so scoring one would
manufacture a false outage anomaly on every metric parked in ``draft``. The
narrow half is the correct one, and it restores the rule the flag already obeys —
a consumer may be NARROWER than detection, never wider.

Stored rows are not deleted, exactly as the ``anomaly_detection_enabled`` toggle
behaves: leaving ``active`` retracts the SIGNAL, while the recorded anomalies
stay on the chart as history because they really happened.

Pure leaf (models only, no service or worker imports) so the async request path
and the sync worker import the same rule and cannot drift — the same reason
``tripl.metric_grid`` exists, and four of the six call sites pass these criteria
straight into ``metric_grid_stmt``.
"""

from __future__ import annotations

from sqlalchemy import ColumnExpressionArgument

from tripl.models.domain_enums import MetricStatus
from tripl.models.metric_definition import MetricDefinition


def monitored_metric_criteria() -> tuple[ColumnExpressionArgument[bool], ...]:
    """SQL half of the predicate, for ``.where(*...)`` / ``metric_grid_stmt(*...)``.

    Deliberately NOT scoped by project: callers scope differently — one project
    for detection, alert candidacy and the Anomalies page, ``project_id.in_(...)``
    for the batched sidebar-badge count — so each adds its own scoping around
    these two.
    """
    return (
        MetricDefinition.status == MetricStatus.active.value,
        MetricDefinition.anomaly_detection_enabled.is_(True),
    )


def is_metric_monitored(metric: MetricDefinition) -> bool:
    """Python half of the SAME predicate, for an already-loaded ORM row.

    Two call sites hold the rows rather than building a statement (the catalog
    list enrichment reads them off the page it already fetched; the drilldown has
    resolved its one metric), so they need the rule as a Python test.

    ``status`` is a ``StrEnum``-backed column that surfaces as either the member
    or its plain string depending on the path, and a ``StrEnum`` member compares
    equal to its own value, so one comparison covers both.

    ``tests/test_metric_monitoring.py`` pins this against
    :func:`monitored_metric_criteria` across the whole status x flag matrix, so
    the two encodings of the rule cannot drift apart.
    """
    return metric.status == MetricStatus.active and metric.anomaly_detection_enabled
