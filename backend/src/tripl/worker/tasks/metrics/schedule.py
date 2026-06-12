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
from sqlalchemy import select

from tripl.models.event_metric import EventMetric
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.worker.celery_app import celery_app
from tripl.worker.tasks.metrics._helpers import (
    _fail_stale_active_scan_job,
    _floor_to_interval,
    _get_active_scan_job,
    _get_sync_session,
)
from tripl.worker.tasks.metrics.tasks import collect_metrics
from tripl.worker.utils.intervals import get_interval

logger = logging.getLogger(__name__)


@celery_app.task(name="tripl.worker.tasks.metrics.check_metrics_due")  # type: ignore[untyped-decorator]
def check_metrics_due() -> dict[str, int]:
    """Check which scan configs are due for metrics collection and dispatch tasks."""
    session = _get_sync_session()
    try:
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
            active_job = _get_active_scan_job(session, config.id)
            if active_job is not None:
                if _fail_stale_active_scan_job(
                    session,
                    active_job,
                    now=now,
                    scan_name=config.name,
                ):
                    active_job = None
                else:
                    logger.info(
                        f"Skipping collect_metrics for {config.name!r}: "
                        f"active job {active_job.id} is {active_job.status}"
                    )
                    continue

            if active_job is not None:
                logger.info(
                    f"Skipping collect_metrics for {config.name!r}: "
                    f"active job {active_job.id} is {active_job.status}"
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
        session.close()
