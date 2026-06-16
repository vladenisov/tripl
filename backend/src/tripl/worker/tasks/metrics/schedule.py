"""Scheduling task for metrics collection.

``check_metrics_due`` scans all configured scan configs and dispatches
``collect_metrics`` for every config with a newly completed interval bucket.
The Celery task name is kept identical via the explicit ``name=`` string.

Tests monkey-patch the session/helper globals of THIS module.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import func as sa_func
from sqlalchemy import select, text
from sqlalchemy.engine import Engine

from tripl.models.event_metric import EventMetric
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.worker.celery_app import celery_app
from tripl.worker.tasks.metrics._helpers import (
    _fail_stale_active_scan_job,
    _floor_to_interval,
    _get_active_scan_jobs,
    _get_sync_session,
)
from tripl.worker.tasks.metrics.tasks import collect_metrics
from tripl.worker.utils.intervals import get_interval

logger = logging.getLogger(__name__)

# A single Postgres session-level advisory lock serialises the whole dispatcher
# across worker processes. With concurrency=N, a backlog of redelivered
# ``check_metrics_due`` messages (e.g. accumulated while the worker was busy or
# after a restart) used to be drained in parallel; the per-config "one active
# job" guard is not atomic, so overlapping runs each created a job for the same
# config in the same instant — duplicate pending/running rows plus duplicate-key
# crashes downstream in anomaly writes. Holding this lock for the duration of a
# run makes any overlapping run a no-op instead. No-op on non-Postgres backends
# (e.g. SQLite in tests).
_DISPATCH_ADVISORY_LOCK_KEY = 4_021_968_017


@celery_app.task(name="tripl.worker.tasks.metrics.check_metrics_due")  # type: ignore[untyped-decorator]
def check_metrics_due() -> dict[str, int]:
    """Check which scan configs are due for metrics collection and dispatch tasks."""
    session = _get_sync_session()
    lock_conn = None
    try:
        bind = session.get_bind()
        if getattr(getattr(bind, "dialect", None), "name", "") == "postgresql":
            engine = bind if isinstance(bind, Engine) else bind.engine
            lock_conn = engine.connect().execution_options(isolation_level="AUTOCOMMIT")
            acquired = bool(
                lock_conn.execute(
                    text("SELECT pg_try_advisory_lock(:key)"),
                    {"key": _DISPATCH_ADVISORY_LOCK_KEY},
                ).scalar()
            )
            if not acquired:
                logger.info(
                    "check_metrics_due: another dispatch run holds the advisory "
                    "lock; skipping this tick"
                )
                lock_conn.close()
                lock_conn = None
                return {"checked": 0, "dispatched": 0}

        configs = (
            session.execute(
                select(ScanConfig).where(
                    ScanConfig.interval.isnot(None),
                    ScanConfig.time_column.isnot(None),
                )
            )
            .scalars()
            .all()
        )

        dispatched = 0
        for config in configs:
            now = datetime.now(UTC)
            # Examine EVERY active job, not just the newest: reap all stale ones
            # so a stuck old job can't be permanently shadowed by a fresher
            # pending row, and skip dispatch only when a genuinely live
            # (non-stale) job remains.
            has_live_job = False
            for active_job in _get_active_scan_jobs(session, config.id):
                if not _fail_stale_active_scan_job(
                    session,
                    active_job,
                    now=now,
                    scan_name=config.name,
                ):
                    has_live_job = True
            if has_live_job:
                logger.info(
                    f"Skipping collect_metrics for {config.name!r}: "
                    "an active job is still in progress"
                )
                continue

            assert config.interval is not None
            interval_spec = get_interval(config.interval)
            delta = interval_spec.delta

            # Check last metric bucket for this config
            last_bucket = session.execute(
                select(sa_func.max(EventMetric.bucket)).where(
                    EventMetric.scan_config_id == config.id,
                )
            ).scalar()

            should_run = False

            if last_bucket is None:
                # Never collected — run now
                should_run = True
            else:
                # Only dispatch when a new complete bucket is available.
                # The latest complete bucket is floor(now) - delta.
                latest_complete = _floor_to_interval(now, delta) - delta
                if last_bucket < latest_complete:
                    should_run = True

            if should_run:
                job = ScanJob(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    status=ScanJobStatus.pending.value,
                )
                session.add(job)
                session.commit()

                logger.info(
                    f"Dispatching collect_metrics for {config.name!r} (interval={config.interval})"
                )
                try:
                    collect_metrics.delay(str(config.id), str(job.id))
                except Exception as exc:
                    job.status = ScanJobStatus.failed.value
                    job.completed_at = datetime.now(UTC)
                    job.error_message = f"Failed to dispatch collect_metrics: {exc}"
                    session.commit()
                    raise
                dispatched += 1

        logger.info(f"check_metrics_due: {len(configs)} configs checked, {dispatched} dispatched")
        return {"checked": len(configs), "dispatched": dispatched}

    except Exception:
        logger.exception("check_metrics_due failed")
        raise
    finally:
        if lock_conn is not None:
            try:
                lock_conn.execute(
                    text("SELECT pg_advisory_unlock(:key)"),
                    {"key": _DISPATCH_ADVISORY_LOCK_KEY},
                )
            except Exception:  # pragma: no cover - best-effort lock release
                logger.exception("Failed to release check_metrics_due advisory lock")
            finally:
                lock_conn.close()
        session.close()
