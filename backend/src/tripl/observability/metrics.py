"""Prometheus app metrics for the tripl API + worker.

Surfaces a small set of counters / histograms so an operator can answer
"are scans running", "are alerts being delivered", "is the worker keeping
up". Kept in one module so both `tripl.main` (HTTP `/metrics` endpoint) and
`tripl.worker.celery_app` (Celery signal handlers) hit the same singletons.

The endpoint and the Celery handlers are wired up only when
``settings.prometheus_metrics_enabled`` is true, so the dev path stays quiet.
"""

from __future__ import annotations

from time import perf_counter
from typing import Any

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)

# Dedicated registry so we don't ship the default-process collectors
# (cpu/memory/fd) that conflict with anything else colocated in the
# container. Operators who want process metrics can opt-in by mounting
# node_exporter / cadvisor next to the app.
REGISTRY = CollectorRegistry()

# Celery task instrumentation. `task` label is the dotted task name
# (`tripl.worker.tasks.metrics.collect_metrics`, etc).
celery_task_seconds = Histogram(
    "tripl_celery_task_seconds",
    "Celery task execution time, by task name.",
    labelnames=("task",),
    # Buckets sized for the actual task profile: metric collection runs
    # ~seconds, anomaly recompute ~tens of seconds, full scan ~minutes.
    buckets=(0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600),
    registry=REGISTRY,
)
celery_tasks_total = Counter(
    "tripl_celery_tasks_total",
    "Celery tasks completed, labelled by task name and outcome.",
    labelnames=("task", "status"),
    registry=REGISTRY,
)

# Business counters that are most useful for ops dashboards.
scan_runs_total = Counter(
    "tripl_scan_runs_total",
    "Scan-config executions, labelled by outcome.",
    labelnames=("status",),
    registry=REGISTRY,
)
anomalies_detected_total = Counter(
    "tripl_anomalies_detected_total",
    "Anomaly rows persisted by the metrics pipeline.",
    labelnames=("scope", "direction"),
    registry=REGISTRY,
)
alert_deliveries_total = Counter(
    "tripl_alert_deliveries_total",
    "Alert delivery attempts, labelled by terminal status.",
    labelnames=("status",),
    registry=REGISTRY,
)
schema_drifts_detected_total = Counter(
    "tripl_schema_drifts_detected_total",
    "Schema drift rows written by the metrics pipeline.",
    labelnames=("drift_type",),
    registry=REGISTRY,
)

# Gauges intended to be sampled (no labels).
metric_check_interval_seconds = Gauge(
    "tripl_metric_check_interval_seconds",
    "Configured interval between metric-due checks (beat schedule).",
    registry=REGISTRY,
)


def render_metrics() -> tuple[bytes, str]:
    """Return ``(body, content_type)`` for the Prometheus exposition format."""
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST


# ---------------------------------------------------------------------------
# Celery wire-up
# ---------------------------------------------------------------------------


def install_celery_instrumentation() -> None:
    """Attach Prometheus instrumentation to celery signals.

    Called from `tripl.worker.celery_app` only when metrics are enabled —
    keeps the dev runner free of the import cost when it's not needed.
    """
    from celery.signals import task_failure, task_postrun, task_prerun

    # Map task_id -> start time so prerun + postrun can pair up across signals.
    _starts: dict[str, float] = {}

    @task_prerun.connect  # type: ignore[untyped-decorator]
    def _on_prerun(task_id: str = "", task: Any = None, **_: Any) -> None:
        _starts[task_id] = perf_counter()

    @task_postrun.connect  # type: ignore[untyped-decorator]
    def _on_postrun(
        task_id: str = "",
        task: Any = None,
        state: str = "SUCCESS",
        **_: Any,
    ) -> None:
        start = _starts.pop(task_id, None)
        task_name = getattr(task, "name", "<unknown>")
        if start is not None:
            celery_task_seconds.labels(task=task_name).observe(perf_counter() - start)
        celery_tasks_total.labels(task=task_name, status=state.lower()).inc()

    @task_failure.connect  # type: ignore[untyped-decorator]
    def _on_failure(task_id: str = "", sender: Any = None, **_: Any) -> None:
        task_name = getattr(sender, "name", "<unknown>")
        celery_tasks_total.labels(task=task_name, status="failure").inc()
