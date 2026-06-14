"""Small shared helpers for the metrics task package.

Keeps timestamp math, the sync-session factory, the adapter builder, and the
"stale active scan job" guard out of the main task module so the entrypoints
(`collect_metrics`, `check_metrics_due`) can stay focused on orchestration.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.models.domain_enums import MetricScopeType
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.worker.db import _build_adapter, _get_sync_session

__all__ = [
    "ACTIVE_SCAN_JOB_STATUSES",
    "MAX_BREAKDOWN_VALUE_LENGTH",
    "RECENT_SIGNAL_WINDOW",
    "SCOPE_SCHEMA_DRIFT",
    "STALE_ACTIVE_SCAN_JOB_TIMEOUT",
    "_build_adapter",
    "_ceil_to_interval",
    "_fail_stale_active_scan_job",
    "_floor_to_interval",
    "_get_active_scan_job",
    "_get_scan_job_activity_at",
    "_get_sync_session",
    "_normalize_job_timestamp",
    "_parse_task_datetime",
]

logger = logging.getLogger(__name__)

ACTIVE_SCAN_JOB_STATUSES = (
    ScanJobStatus.pending.value,
    ScanJobStatus.running.value,
)
STALE_ACTIVE_SCAN_JOB_TIMEOUT = timedelta(minutes=30)
RECENT_SIGNAL_WINDOW = timedelta(hours=24)
MAX_BREAKDOWN_VALUE_LENGTH = 500
SCOPE_SCHEMA_DRIFT = MetricScopeType.schema.value


def _floor_to_interval(dt: datetime, delta: timedelta) -> datetime:
    """Floor a datetime to the nearest interval boundary."""
    epoch = datetime(2000, 1, 1, tzinfo=UTC)
    if dt.tzinfo is None:
        epoch = epoch.replace(tzinfo=None)
    total_seconds = delta.total_seconds()
    elapsed = (dt - epoch).total_seconds()
    floored = int(elapsed // total_seconds) * total_seconds
    return epoch + timedelta(seconds=floored)


def _ceil_to_interval(dt: datetime, delta: timedelta) -> datetime:
    floored = _floor_to_interval(dt, delta)
    if floored == dt:
        return floored
    return floored + delta


def _parse_task_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _get_active_scan_job(session: Session, scan_config_id: uuid.UUID) -> ScanJob | None:
    """Return the newest pending/running job for a scan config, if any."""
    return session.execute(
        select(ScanJob)
        .where(
            ScanJob.scan_config_id == scan_config_id,
            ScanJob.status.in_(ACTIVE_SCAN_JOB_STATUSES),
        )
        .order_by(ScanJob.created_at.desc())
        .limit(1)
    ).scalar_one_or_none()


def _normalize_job_timestamp(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _get_scan_job_activity_at(job: ScanJob) -> datetime:
    activity_at = job.started_at or job.updated_at or job.created_at
    return _normalize_job_timestamp(activity_at)


def _fail_stale_active_scan_job(
    session: Session,
    job: ScanJob,
    *,
    now: datetime,
    scan_name: str,
) -> bool:
    activity_at = _get_scan_job_activity_at(job)
    if now - activity_at < STALE_ACTIVE_SCAN_JOB_TIMEOUT:
        return False

    logger.warning(
        "Marking stale active job %s for %r as failed; status=%s, last_activity=%s",
        job.id,
        scan_name,
        job.status,
        activity_at.isoformat(),
    )
    job.status = ScanJobStatus.failed.value
    job.completed_at = now
    job.error_message = (
        "Marked failed by scheduler after "
        f"{int(STALE_ACTIVE_SCAN_JOB_TIMEOUT.total_seconds() // 60)} minutes without progress"
    )
    session.commit()
    return True
