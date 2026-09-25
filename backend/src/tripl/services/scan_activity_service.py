"""Per-scan run activity for the Scans list, aggregated in SQL (tripl-fj5g.11).

The list used to derive three figures from a capped page of each scan's jobs —
the last run, the current failing streak, and the rows read in the last 24 hours
— so a scan that ran more often than the page held showed the streak and the
24h total as floors ("failed last 10+ runs", "1.2M+"). Loading every job to make
them exact is what tripl-jfm3.107 capped in the first place, so each figure is
one grouped query here instead, over every scan config in the project at once.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import Float, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.schemas.scan_job import ScanActivityItem, ScanActivityResponse, ScanJobResponse
from tripl.services.project_lookup import get_project_id_by_slug

ACTIVITY_WINDOW = timedelta(hours=24)

# A settled job that is not a failure ends a failing streak. Queued and running
# jobs are looked past, as the frontend's ``consecutiveFailedRuns`` does: a retry
# waiting behind five failures must not hide them.
_STREAK_BREAKING_STATUSES = (ScanJobStatus.completed.value, ScanJobStatus.cancelled.value)


async def _latest_jobs(
    session: AsyncSession, scan_ids: list[uuid.UUID]
) -> dict[uuid.UUID, ScanJob]:
    ranked = (
        select(
            ScanJob.id.label("job_id"),
            func.row_number()
            .over(
                partition_by=ScanJob.scan_config_id,
                order_by=(ScanJob.created_at.desc(), ScanJob.id.desc()),
            )
            .label("row_number"),
        )
        .where(ScanJob.scan_config_id.in_(scan_ids))
        .subquery()
    )
    rows = await session.execute(
        select(ScanJob).join(ranked, ranked.c.job_id == ScanJob.id).where(ranked.c.row_number == 1)
    )
    return {job.scan_config_id: job for job in rows.scalars().all()}


async def _failing_streaks(
    session: AsyncSession, scan_ids: list[uuid.UUID]
) -> dict[uuid.UUID, int]:
    """Failed jobs newer than each scan's newest completed or cancelled job."""
    last_break = (
        select(
            ScanJob.scan_config_id.label("scan_config_id"),
            func.max(ScanJob.created_at).label("created_at"),
        )
        .where(
            ScanJob.scan_config_id.in_(scan_ids),
            ScanJob.status.in_(_STREAK_BREAKING_STATUSES),
        )
        .group_by(ScanJob.scan_config_id)
        .subquery()
    )
    rows = await session.execute(
        select(ScanJob.scan_config_id, func.count())
        .outerjoin(last_break, last_break.c.scan_config_id == ScanJob.scan_config_id)
        .where(
            ScanJob.scan_config_id.in_(scan_ids),
            ScanJob.status == ScanJobStatus.failed.value,
            or_(last_break.c.created_at.is_(None), ScanJob.created_at > last_break.c.created_at),
        )
        .group_by(ScanJob.scan_config_id)
    )
    return {scan_id: int(count or 0) for scan_id, count in rows.all()}


async def _rows_read_since(
    session: AsyncSession, scan_ids: list[uuid.UUID], window_from: datetime
) -> dict[uuid.UUID, int]:
    """Sum of each job's rows read, for jobs stamped inside the window.

    A job's stamp is ``completed_at``, else ``started_at`` — the one the list
    used — and its rows are ``query_rows_scanned``, else ``scan_rows_processed``
    (``jobRowsScanned`` in the frontend). Extracted as floats: the counters are
    JSON numbers, and a BigQuery run can read past a 32-bit integer.
    """
    summary = ScanJob.result_summary
    rows_read = func.coalesce(
        summary["query_rows_scanned"].as_float(),
        summary["scan_rows_processed"].as_float(),
        cast(0, Float),
    )
    rows = await session.execute(
        select(ScanJob.scan_config_id, func.sum(rows_read))
        .where(
            ScanJob.scan_config_id.in_(scan_ids),
            func.coalesce(ScanJob.completed_at, ScanJob.started_at) >= window_from,
        )
        .group_by(ScanJob.scan_config_id)
    )
    return {scan_id: round(total or 0) for scan_id, total in rows.all()}


async def get_scan_activity(
    session: AsyncSession, slug: str, *, now: datetime
) -> ScanActivityResponse:
    """Every scan config's latest job, failing streak and 24h rows read.

    Items follow the scan list's own order (newest config first), and a config
    that never ran is present with no job, a zero streak and zero rows.
    """
    project_id = await get_project_id_by_slug(session, slug)
    scan_ids = list(
        (
            await session.scalars(
                select(ScanConfig.id)
                .where(ScanConfig.project_id == project_id)
                .order_by(ScanConfig.created_at.desc())
            )
        ).all()
    )
    window_from = now - ACTIVITY_WINDOW
    if not scan_ids:
        return ScanActivityResponse(window_from=window_from, window_to=now, items=[])

    latest = await _latest_jobs(session, scan_ids)
    streaks = await _failing_streaks(session, scan_ids)
    rows_read = await _rows_read_since(session, scan_ids, window_from)
    items = [
        ScanActivityItem(
            scan_config_id=scan_id,
            latest_job=(
                ScanJobResponse.model_validate(latest[scan_id]) if scan_id in latest else None
            ),
            failing_streak=streaks.get(scan_id, 0),
            rows_read_24h=rows_read.get(scan_id, 0),
        )
        for scan_id in scan_ids
    ]
    return ScanActivityResponse(window_from=window_from, window_to=now, items=items)
