"""Read-side extras for one scan config: its metrics schedule (DA-5).

``scan_service`` owns the config CRUD; this module answers "when did metrics
collection last run for this scan, and when is it next due" for the scan detail
page, with the scheduler's own pure functions rather than a port of its rule.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.event_metric import EventMetric
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.schemas.scan_config import ScanConfigDetailResponse
from tripl.services import scan_service
from tripl.services.monitoring_utils import scan_interval_to_timedelta


async def get_scan_config_detail(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
    *,
    now: datetime | None = None,
) -> ScanConfigDetailResponse:
    """The config plus ``last_metrics_run_at`` / ``next_metrics_run_at``."""
    config = await scan_service.get_scan_config(session, slug, scan_id)
    last_run_at, next_run_at = await _metrics_schedule(
        session, config, now=now or datetime.now(UTC)
    )
    return ScanConfigDetailResponse.model_validate(config).model_copy(
        update={"last_metrics_run_at": last_run_at, "next_metrics_run_at": next_run_at}
    )


async def _metrics_schedule(
    session: AsyncSession,
    config: ScanConfig,
    *,
    now: datetime,
) -> tuple[datetime | None, datetime | None]:
    """``(last_metrics_run_at, next_metrics_run_at)`` for one scan config.

    The dispatcher collects only a config with an interval AND a time column
    (``check_metrics_due``), so either missing means no next run. The next run
    is the scheduler's bucket-half due check
    (``schedule.scan_config_collection_schedule``): the earliest moment the
    config is due, which the dispatcher may still hold back (a live job, the
    failure backoff, a demo's cooldown) — the same promise the monitoring
    drilldown's ``next_collection_at`` makes. Imported lazily, like
    ``metrics_service``'s scheduler read, to keep the request path out of the
    Celery import graph until it is used.
    """
    from tripl.worker.tasks.metrics.schedule import (
        scan_config_collection_progress,
        scan_config_collection_schedule,
    )
    from tripl.worker.tasks.metrics.tasks import _RECENT_JOB_SCAN_LIMIT

    rows = await session.execute(
        select(ScanJob.result_summary, ScanJob.completed_at)
        .where(
            ScanJob.scan_config_id == config.id,
            ScanJob.status == ScanJobStatus.completed.value,
        )
        .order_by(ScanJob.created_at.desc())
        .limit(_RECENT_JOB_SCAN_LIMIT)
    )
    last_run_at, watermark = scan_config_collection_progress(rows.tuples().all())

    delta = scan_interval_to_timedelta(config.interval)
    if delta is None or not config.time_column:
        return last_run_at, None

    # Bounded like every ``event_metrics`` read: a newest bucket older than two
    # intervals leaves the config due whatever its exact value, so the floor
    # changes no answer.
    last_bucket = await session.scalar(
        select(func.max(EventMetric.bucket)).where(
            EventMetric.scan_config_id == config.id,
            EventMetric.bucket >= now - 2 * delta,
        )
    )
    next_run_at, _due = scan_config_collection_schedule(
        last_bucket=last_bucket,
        watermark=watermark,
        delta=delta,
        now=now,
    )
    return last_run_at, next_run_at
