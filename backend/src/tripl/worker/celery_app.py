from celery import Celery

from tripl.config import settings
from tripl.services.app_settings_service import apply_startup_service_overrides

# Apply persisted Security/Storage/Observability overrides onto `settings` before
# anything reads them (the prometheus gate below, logging, and task modules).
# Mirrors the API entry point so the worker honours the same overrides.
apply_startup_service_overrides()

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

# A request-path publish must fail fast. Most dispatches happen inside async API
# handlers — services/_celery_dispatch.py keeps them off the event loop, but a
# caller still waits for the thread — and Celery's defaults (a 4s connect
# timeout against 1+3 publish attempts) let one unreachable broker hold that
# caller for ~19s. These bounds cut the worst case to ~7s. The worker's own
# startup connect is unaffected: broker_connection_retry_on_startup keeps
# retrying it.
celery_app.conf.broker_connection_timeout = 2.0
celery_app.conf.task_publish_retry_policy = {
    "max_retries": 2,
    "interval_start": 0,
    "interval_step": 0.2,
    "interval_max": 0.5,
}

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
    "check-metric-definitions-due": {
        "task": "tripl.worker.tasks.metrics.check_metric_definitions_due",
        # Catalog metrics schedule on interval boundaries (15m, 1h, …) just like
        # scans, so a 5-minute dispatcher tick is plenty. Runs independently of
        # check-metrics-due (separate task + advisory lock).
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
    "sync-implementation-tickets": {
        "task": "tripl.worker.tasks.implementation_tickets.sync_implementation_tickets",
        # Poll every 5 minutes — implementation tickets close on human timescales
        # (a dev finishing a Jira issue), so tighter polling buys nothing and only
        # adds load against the tracker's REST API.
        "schedule": 300.0,
    },
    "reindex-stale-search-documents": {
        "task": "tripl.worker.tasks.search.reindex_stale_search_documents",
        # Every 10 minutes, and each pass takes only STALE_REINDEX_BRANCHES_PER_RUN
        # branches. A builder bump is rare and the corpus it has to repair is
        # bounded by the branch count, so this trades speed for staying out of the
        # API's way — a 10-branch instance is fully converted inside an hour, the
        # same order as the delay main already has (it waits for the next scan).
        # Between bumps the query matches nothing and a pass is one indexed lookup.
        "schedule": 600.0,
    },
    "requeue-stranded-search-embeddings": {
        "task": "tripl.worker.tasks.search.requeue_stranded_search_embeddings",
        # Every 15 minutes — embeddings refresh event-driven after each reindex;
        # this chaser only bounds how long a lost queue message or an exhausted
        # batch retry can leave documents pending (STRANDED_EMBEDDING_MINUTES).
        "schedule": 900.0,
    },
    "flush-due-alert-digests": {
        "task": "tripl.worker.tasks.alert_flush.flush_due_alert_digests",
        # 60s, not the 300s the other dispatchers use. Those poll for work that
        # lands on 15m/1h/6h boundaries and nobody watches the clock for; a
        # digest cadence is a wall-clock time the operator TYPED, and the UI
        # offers a cron minute field. At 300s "daily at 09:00" would arrive
        # anywhere in [09:00, 09:05) and the minute field would be a lie.
        #
        # The tick is cheap enough to justify it: one indexed read of
        # alert_destinations filtered to the enabled+scheduled rows (tens, not
        # millions), and nothing else at all when none are due. Compare
        # check-metrics-due, which does a grouped max(bucket) over the metrics
        # table every 300s.
        "schedule": 60.0,
    },
    "advance-demos": {
        "task": "tripl.worker.tasks.demo_runtime.advance_demos",
        # Every 5 minutes — demos advance on hourly bucket boundaries, so 5-minute
        # polling keeps them inside the freshness horizon with headroom, and the
        # per-demo tick is idempotent so an early/overlapping run is a no-op. A
        # no-op entirely when demo_runtime_enabled is false. Independent of the
        # metrics dispatchers (own task + per-project advisory lock).
        "schedule": 300.0,
    },
}

# Fork-safety: apply_startup_service_overrides() above reads the DB in the
# parent (MainProcess), which lazily builds the shared sync Engine + pool BEFORE
# prefork forks the worker children. Forked children would otherwise inherit that
# engine and its live Postgres socket, interleaving protocol traffic on ONE
# shared connection across tasks. Disposing the inherited engine in each child
# forces the next SyncSessionLocal() to rebuild a fresh, process-owned pool.
from celery.signals import worker_process_init  # noqa: E402

from tripl.worker.db import dispose_engine  # noqa: E402


@worker_process_init.connect  # type: ignore[untyped-decorator]
def _reset_sync_engine_after_fork(**_kwargs: object) -> None:
    dispose_engine()


# Import tasks so they are registered with the celery app
import tripl.worker.tasks.alert_digest_send  # noqa: F401, E402
import tripl.worker.tasks.alert_flush  # noqa: F401, E402
import tripl.worker.tasks.alerts  # noqa: F401, E402
import tripl.worker.tasks.demo_runtime  # noqa: F401, E402
import tripl.worker.tasks.implementation_tickets  # noqa: F401, E402
import tripl.worker.tasks.maintenance  # noqa: F401, E402
import tripl.worker.tasks.metrics  # noqa: F401, E402
import tripl.worker.tasks.scan  # noqa: F401, E402
import tripl.worker.tasks.scan_dry_run  # noqa: F401, E402
import tripl.worker.tasks.search  # noqa: F401, E402
