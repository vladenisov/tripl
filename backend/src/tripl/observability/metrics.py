"""Prometheus app metrics for the tripl API + worker.

Surfaces a small set of counters / histograms so an operator can answer
"are scans running", "are alerts being delivered", "is the worker keeping
up". Worker processes write to PROMETHEUS_MULTIPROC_DIR; the API reads that
shared directory at scrape time. Without that environment variable, only
metrics from the API process are exported.

The endpoint and the Celery handlers are wired up only when
``settings.prometheus_metrics_enabled`` is true, so the dev path stays quiet.
"""

from __future__ import annotations

import os
import socket
from time import perf_counter
from typing import Any

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
    multiprocess,
    values,
)


def _process_identifier() -> str:
    """Name this process's shard uniquely across containers sharing the directory."""
    return f"{socket.gethostname()}-{os.getpid()}"


# The API, worker and beat containers share PROMETHEUS_MULTIPROC_DIR but not a
# PID namespace, so the library's default os.getpid() shard names collide across
# containers and two processes would append to one mmap file. The container
# hostname keeps them apart. Must be set before the first metric below.
if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
    values.ValueClass = values.MultiProcessValue(process_identifier=_process_identifier)  # type: ignore[no-untyped-call]

# Dedicated registry for the single-process fallback. In multiprocess mode,
# metric objects still write to their process files, but scraping requires a
# fresh registry with MultiProcessCollector to avoid duplicate series.
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
settings_read_failures_total = Counter(
    "tripl_settings_read_failures_total",
    "Settings-table read failures that forced environment-only configuration.",
    labelnames=("section",),
    registry=REGISTRY,
)
alert_delivery_missing_items_total = Counter(
    "tripl_alert_delivery_missing_items_total",
    "Alert deliveries sent with a positive matched count but no surviving items.",
    registry=REGISTRY,
)
schema_drifts_detected_total = Counter(
    "tripl_schema_drifts_detected_total",
    "Schema drift rows written by the metrics pipeline.",
    labelnames=("drift_type",),
    registry=REGISTRY,
)


def render_metrics() -> tuple[bytes, str]:
    """Return ``(body, content_type)`` for the Prometheus exposition format."""
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)  # type: ignore[no-untyped-call]
        return generate_latest(registry), CONTENT_TYPE_LATEST
    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST


# ---------------------------------------------------------------------------
# Celery wire-up
# ---------------------------------------------------------------------------

_celery_instrumentation_installed = False


def install_celery_instrumentation() -> None:
    """Attach Prometheus instrumentation to celery signals.

    Called from `tripl.worker.celery_app` only when metrics are enabled —
    keeps the dev runner free of the import cost when it's not needed.
    """
    global _celery_instrumentation_installed

    if _celery_instrumentation_installed:
        return

    from celery.signals import task_postrun, task_prerun

    # Map task_id -> start time so prerun + postrun can pair up across signals.
    _starts: dict[str, float] = {}

    def _on_prerun(task_id: str = "", task: Any = None, **_: Any) -> None:
        _starts[task_id] = perf_counter()

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

    # Celery's default weak references would discard these local closures as
    # soon as this installer returns, leaving the worker without task metrics.
    task_prerun.connect(_on_prerun, weak=False)
    task_postrun.connect(_on_postrun, weak=False)
    _celery_instrumentation_installed = True
