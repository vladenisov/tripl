from celery import Celery

from tripl.config import settings

if settings.prometheus_metrics_enabled:
    from tripl.observability.metrics import install_celery_instrumentation

    install_celery_instrumentation()

# Opt-in OpenTelemetry tracing for Celery — same env gate as the API.
from tripl.observability.tracing import setup_worker_tracing  # noqa: E402

setup_worker_tracing()

celery_app = Celery("tripl")
celery_app.conf.broker_url = settings.rabbitmq_url
celery_app.conf.result_backend = None
celery_app.conf.task_serializer = "json"
celery_app.conf.accept_content = ["json"]
celery_app.conf.timezone = "UTC"
celery_app.conf.broker_connection_retry_on_startup = True

# Reliability: only ack tasks after successful completion so a crashed worker
# re-queues them. Combined with reject_on_worker_lost for hard kills (OOM, SIGKILL).
celery_app.conf.task_acks_late = True
celery_app.conf.task_reject_on_worker_lost = True

# Default hard cap so a runaway task can't block the queue. Long-running tasks
# such as metrics replay may override this per task. Soft limit raises
# SoftTimeLimitExceeded so tasks can clean up; hard limit SIGKILLs the worker
# after the grace period.
celery_app.conf.task_soft_time_limit = 55 * 60  # 55 min
celery_app.conf.task_time_limit = 60 * 60  # 60 min

# Prefetch 1 task per worker — prevents one slow worker from hoarding the queue
# while others idle. Safer default for unpredictable task durations.
celery_app.conf.worker_prefetch_multiplier = 1

# Require deduplication tags to be stable so retried tasks aren't treated as new.
celery_app.conf.task_default_retry_delay = 30

celery_app.conf.beat_schedule = {
    "check-metrics-due": {
        "task": "tripl.worker.tasks.metrics.check_metrics_due",
        # Scans schedule on interval boundaries (15m, 1h, 6h, …), so 5-minute
        # polling is more than enough and leaves headroom if the dispatcher
        # itself becomes slow against a growing scan_configs table.
        "schedule": 300.0,
    },
    "cleanup-schema-drifts": {
        "task": "tripl.worker.tasks.maintenance.cleanup_schema_drifts",
        # Daily prune is plenty — drift rows past retention are filtered
        # out at read time anyway, the cleanup only reclaims storage.
        "schedule": 24 * 60 * 60.0,
    },
    "requeue-stranded-alert-deliveries": {
        "task": "tripl.worker.tasks.maintenance.requeue_stranded_alert_deliveries",
        # Every 5 minutes — deliveries are only considered stranded after
        # STRANDED_DELIVERY_MINUTES, so this just bounds detection latency for
        # rows the worker/broker failed to dispatch.
        "schedule": 300.0,
    },
    "send-weekly-plan-digest": {
        "task": "tripl.worker.tasks.alerts.send_weekly_plan_digest",
        "schedule": 7 * 24 * 60 * 60.0,
    },
}

# Import tasks so they are registered with the celery app
import tripl.worker.tasks.alerts  # noqa: F401, E402
import tripl.worker.tasks.maintenance  # noqa: F401, E402
import tripl.worker.tasks.metrics  # noqa: F401, E402
import tripl.worker.tasks.scan  # noqa: F401, E402
import tripl.worker.tasks.search  # noqa: F401, E402
