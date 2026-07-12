import logging
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.data_source import DataSource, DBType
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.scan_preview_job import ScanPreviewJob
from tripl.schemas.scan_config import (
    ScanConfigCreate,
    ScanConfigPreviewRequest,
    ScanConfigUpdate,
    ScanMetricsReplayRequest,
    check_replay_chunk_against_interval,
    check_scalar_columns_unreserved,
)
from tripl.services.project_lookup import get_project_id_by_slug

logger = logging.getLogger(__name__)


async def _verify_data_source(
    session: AsyncSession, ds_id: uuid.UUID, project_id: uuid.UUID | None = None
) -> DataSource:
    result = await session.execute(select(DataSource).where(DataSource.id == ds_id))
    ds = result.scalar_one_or_none()
    if ds is None:
        raise HTTPException(status_code=404, detail="Data source not found")
    # A synthetic (local demo) source belongs to exactly one demo project and must
    # never be selected by any other project — that is how an ordinary project is
    # kept from pointing a scan/preview at demo data. Identity is db_type +
    # project ownership, never slug/host/name.
    if (
        ds.db_type == DBType.synthetic
        and project_id is not None
        and ds.project_id != project_id
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "Synthetic data sources belong to their demo project "
                "and cannot be selected here."
            ),
        )
    return ds


async def list_scan_configs(session: AsyncSession, slug: str) -> list[ScanConfig]:
    project_id = await get_project_id_by_slug(session, slug)
    result = await session.execute(
        select(ScanConfig)
        .where(ScanConfig.project_id == project_id)
        .order_by(ScanConfig.created_at.desc())
    )
    return list(result.scalars().all())


async def get_scan_config(session: AsyncSession, slug: str, scan_id: uuid.UUID) -> ScanConfig:
    project_id = await get_project_id_by_slug(session, slug)
    result = await session.execute(
        select(ScanConfig).where(ScanConfig.id == scan_id, ScanConfig.project_id == project_id)
    )
    config = result.scalar_one_or_none()
    if config is None:
        raise HTTPException(status_code=404, detail="Scan config not found")
    return config


async def create_scan_config(
    session: AsyncSession, slug: str, data: ScanConfigCreate
) -> ScanConfig:
    project_id = await get_project_id_by_slug(session, slug)
    await _verify_data_source(session, data.data_source_id, project_id)

    existing = await session.execute(
        select(ScanConfig).where(
            ScanConfig.project_id == project_id,
            ScanConfig.data_source_id == data.data_source_id,
            ScanConfig.name == data.name,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Scan config with this name already exists")

    config = ScanConfig(
        project_id=project_id,
        **data.model_dump(),
    )
    session.add(config)
    await session.commit()
    await session.refresh(config)
    return config


async def update_scan_config(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
    data: ScanConfigUpdate,
) -> ScanConfig:
    config = await get_scan_config(session, slug, scan_id)
    update_dict = data.model_dump(exclude_unset=True)
    # PATCH semantics: merge the partial payload onto the live config first so
    # cross-field checks see the post-update state, not just the diff.
    try:
        check_scalar_columns_unreserved(
            metric_breakdown_columns=update_dict.get(
                "metric_breakdown_columns", config.metric_breakdown_columns
            )
            or [],
            distribution_drift_fields=update_dict.get(
                "distribution_drift_fields", config.distribution_drift_fields
            )
            or [],
            event_type_column=update_dict.get("event_type_column", config.event_type_column),
            time_column=update_dict.get("time_column", config.time_column),
            app_version_column=update_dict.get(
                "app_version_column", config.app_version_column
            ),
            platform_column=update_dict.get("platform_column", config.platform_column),
        )
        check_replay_chunk_against_interval(
            interval=update_dict.get("interval", config.interval),
            replay_chunk_interval=update_dict.get(
                "replay_chunk_interval", config.replay_chunk_interval
            ),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    for key, value in update_dict.items():
        setattr(config, key, value)
    await session.commit()
    await session.refresh(config)
    return config


async def trigger_event_groups_apply(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
) -> ScanJob:
    config = await get_scan_config(session, slug, scan_id)
    if not config.event_group_rules:
        raise HTTPException(status_code=400, detail="Scan config has no event group rules")

    job = ScanJob(
        scan_config_id=config.id,
        status=ScanJobStatus.pending.value,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)

    from tripl.worker.tasks.scan import apply_event_groups

    try:
        apply_event_groups.delay(str(config.id), str(job.id))
    except Exception:
        job.status = ScanJobStatus.failed.value
        job.error_message = "Failed to dispatch task to worker (broker unavailable)"
        await session.commit()
        await session.refresh(job)
    return job


async def trigger_preview(
    session: AsyncSession,
    slug: str,
    data: ScanConfigPreviewRequest,
) -> ScanPreviewJob:
    """Create a ScanPreviewJob for an unsaved draft and dispatch the worker task.

    Preview queries the warehouse and can exceed the gateway timeout, so the
    work runs in the worker; the client polls ``get_preview_job`` for the result.
    """
    project_id = await get_project_id_by_slug(session, slug)
    await _verify_data_source(session, data.data_source_id, project_id)

    job = ScanPreviewJob(
        project_id=project_id,
        data_source_id=data.data_source_id,
        base_query=data.base_query,
        json_value_paths=data.json_value_paths,
        row_limit=data.limit,
        time_column=data.time_column,
        scan_lookback_hours=data.scan_lookback_hours,
        include_json_paths=data.include_json_paths,
        status=ScanJobStatus.pending.value,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)

    from tripl.worker.tasks.scan import preview_scan_config_async

    try:
        preview_scan_config_async.delay(str(job.id))
    except Exception:
        job.status = ScanJobStatus.failed.value
        job.error_message = "Failed to dispatch task to worker (broker unavailable)"
        await session.commit()
        await session.refresh(job)
    return job


async def get_preview_job(
    session: AsyncSession,
    slug: str,
    job_id: uuid.UUID,
) -> ScanPreviewJob:
    project_id = await get_project_id_by_slug(session, slug)
    result = await session.execute(
        select(ScanPreviewJob).where(
            ScanPreviewJob.id == job_id,
            ScanPreviewJob.project_id == project_id,
        )
    )
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Scan preview job not found")
    return job


async def delete_scan_config(session: AsyncSession, slug: str, scan_id: uuid.UUID) -> None:
    config = await get_scan_config(session, slug, scan_id)
    await session.delete(config)
    await session.commit()


async def trigger_scan(session: AsyncSession, slug: str, scan_id: uuid.UUID) -> ScanJob:
    """Create a ScanJob and dispatch the Celery task."""
    config = await get_scan_config(session, slug, scan_id)

    job = ScanJob(
        scan_config_id=config.id,
        status=ScanJobStatus.pending.value,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)

    # Import here to avoid circular imports at module level
    from tripl.worker.tasks.scan import run_scan

    try:
        run_scan.delay(str(config.id), str(job.id))
    except Exception:
        job.status = ScanJobStatus.failed.value
        job.error_message = "Failed to dispatch task to worker (broker unavailable)"
        await session.commit()
        await session.refresh(job)
    return job


async def trigger_metrics_replay(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
    data: ScanMetricsReplayRequest,
) -> ScanJob:
    """Create a ScanJob and dispatch metrics collection for an explicit window."""
    config = await get_scan_config(session, slug, scan_id)
    if not config.time_column or not config.interval:
        raise HTTPException(
            status_code=400,
            detail="Scan config requires time_column and interval to replay metrics",
        )

    job = ScanJob(
        scan_config_id=config.id,
        status=ScanJobStatus.pending.value,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)

    from tripl.worker.tasks.metrics import collect_metrics

    try:
        collect_metrics.delay(
            str(config.id),
            str(job.id),
            data.time_from.isoformat(),
            data.time_to.isoformat(),
        )
    except Exception:
        job.status = ScanJobStatus.failed.value
        job.error_message = "Failed to dispatch task to worker (broker unavailable)"
        await session.commit()
        await session.refresh(job)
    return job


async def list_scan_jobs(session: AsyncSession, slug: str, scan_id: uuid.UUID) -> list[ScanJob]:
    await get_scan_config(session, slug, scan_id)
    result = await session.execute(
        select(ScanJob).where(ScanJob.scan_config_id == scan_id).order_by(ScanJob.created_at.desc())
    )
    return list(result.scalars().all())


async def get_scan_job(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
    job_id: uuid.UUID,
) -> ScanJob:
    await get_scan_config(session, slug, scan_id)
    result = await session.execute(
        select(ScanJob).where(ScanJob.id == job_id, ScanJob.scan_config_id == scan_id)
    )
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Scan job not found")
    return job


async def cancel_scan_job(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
    job_id: uuid.UUID,
) -> ScanJob:
    """Cancel an active (pending/running) scan job.

    Marks the job ``cancelled`` and best-effort revokes the Celery task. A
    running task is not killed: it polls this status at each chunk boundary and
    stops cooperatively, leaving already-written metrics intact.
    """
    job = await get_scan_job(session, slug, scan_id, job_id)
    if job.status not in (ScanJobStatus.pending.value, ScanJobStatus.running.value):
        raise HTTPException(
            status_code=409,
            detail=f"Scan job is not active (status: {job.status})",
        )

    if job.celery_task_id:
        try:
            from tripl.worker.celery_app import celery_app

            celery_app.control.revoke(job.celery_task_id)
        except Exception:  # noqa: BLE001 — revoke is best-effort; cooperative stop is the backstop
            logger.warning(
                "Failed to revoke celery task %s for scan job %s",
                job.celery_task_id,
                job.id,
                exc_info=True,
            )

    job.status = ScanJobStatus.cancelled.value
    job.completed_at = datetime.now(UTC)
    job.error_message = "Cancelled by user"
    await session.commit()
    await session.refresh(job)
    return job
