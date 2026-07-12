import uuid

from fastapi import APIRouter, Depends

from tripl.api.deps import EditorUserDep, SessionDep, get_editor_user
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob
from tripl.models.scan_preview_job import ScanPreviewJob
from tripl.schemas.event_metric import PlatformPresenceResponse
from tripl.schemas.scan_config import (
    ScanConfigCreate,
    ScanConfigPreviewRequest,
    ScanConfigResponse,
    ScanConfigUpdate,
    ScanMetricsReplayRequest,
)
from tripl.schemas.scan_job import ScanJobResponse, ScanPreviewJobResponse
from tripl.services import audit_service, metrics_service, scan_service

# Handlers return ORM models; FastAPI serializes them through each route's
# ``response_model=...Response`` (the OpenAPI contract). The return annotations
# below name the ORM type actually returned so mypy matches the runtime, while
# response_model still drives schema generation and output validation.

router = APIRouter(
    prefix="/projects/{slug}/scans",
    tags=["scans"],
)
_editor_required = [Depends(get_editor_user)]


@router.get("", response_model=list[ScanConfigResponse])
async def list_scan_configs(session: SessionDep, slug: str) -> list[ScanConfig]:
    return await scan_service.list_scan_configs(session, slug)


@router.post("", response_model=ScanConfigResponse, status_code=201)
async def create_scan_config(
    session: SessionDep,
    slug: str,
    data: ScanConfigCreate,
    current_user: EditorUserDep,
) -> ScanConfig:
    cfg = await scan_service.create_scan_config(session, slug, data)
    await audit_service.record(
        session,
        user=current_user,
        action="scan_config.create",
        target_type="scan_config",
        target_id=cfg.id,
        target_name=cfg.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return cfg


@router.post(
    "/preview",
    response_model=ScanPreviewJobResponse,
    status_code=202,
    dependencies=_editor_required,
)
async def preview_scan_config(
    session: SessionDep,
    slug: str,
    data: ScanConfigPreviewRequest,
) -> ScanPreviewJob:
    """Enqueue a preview job; poll GET /preview-jobs/{job_id} for the result."""
    return await scan_service.trigger_preview(session, slug, data)


@router.get(
    "/preview-jobs/{job_id}",
    response_model=ScanPreviewJobResponse,
    dependencies=_editor_required,
)
async def get_scan_preview_job(
    session: SessionDep,
    slug: str,
    job_id: uuid.UUID,
) -> ScanPreviewJob:
    return await scan_service.get_preview_job(session, slug, job_id)


@router.get("/{scan_id}", response_model=ScanConfigResponse)
async def get_scan_config(session: SessionDep, slug: str, scan_id: uuid.UUID) -> ScanConfig:
    return await scan_service.get_scan_config(session, slug, scan_id)


@router.get("/{scan_id}/platform-presence", response_model=PlatformPresenceResponse)
async def get_platform_presence(
    session: SessionDep, slug: str, scan_id: uuid.UUID
) -> PlatformPresenceResponse:
    """Per-event platform presence matrix for the scan's platform_column.

    Empty when the scan has no platform_column set (the platform dimension is
    inert), so callers can render the panel unconditionally."""
    return await metrics_service.get_platform_presence(session, slug, scan_id)


@router.patch("/{scan_id}", response_model=ScanConfigResponse)
async def update_scan_config(
    session: SessionDep,
    slug: str,
    scan_id: uuid.UUID,
    data: ScanConfigUpdate,
    current_user: EditorUserDep,
) -> ScanConfig:
    cfg = await scan_service.update_scan_config(session, slug, scan_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="scan_config.update",
        target_type="scan_config",
        target_id=cfg.id,
        target_name=cfg.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return cfg


@router.delete("/{scan_id}", status_code=204)
async def delete_scan_config(
    session: SessionDep,
    slug: str,
    scan_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    existing = await scan_service.get_scan_config(session, slug, scan_id)
    name = getattr(existing, "name", "")
    await scan_service.delete_scan_config(session, slug, scan_id)
    await audit_service.record(
        session,
        user=current_user,
        action="scan_config.delete",
        target_type="scan_config",
        target_id=scan_id,
        target_name=name,
        project_slug=slug,
    )


@router.post(
    "/{scan_id}/run",
    response_model=ScanJobResponse,
    status_code=201,
    dependencies=_editor_required,
)
async def run_scan(session: SessionDep, slug: str, scan_id: uuid.UUID) -> ScanJob:
    return await scan_service.trigger_scan(session, slug, scan_id)


@router.post(
    "/{scan_id}/event-groups/apply",
    response_model=ScanJobResponse,
    status_code=201,
)
async def apply_scan_event_groups(
    session: SessionDep,
    slug: str,
    scan_id: uuid.UUID,
    current_user: EditorUserDep,
) -> ScanJob:
    job = await scan_service.trigger_event_groups_apply(session, slug, scan_id)
    cfg = await scan_service.get_scan_config(session, slug, scan_id)
    await audit_service.record(
        session,
        user=current_user,
        action="scan_config.event_groups.apply",
        target_type="scan_config",
        target_id=scan_id,
        target_name=cfg.name,
        project_slug=slug,
        payload={"scan_job_id": str(job.id)},
    )
    return job


@router.post(
    "/{scan_id}/metrics/replay",
    response_model=ScanJobResponse,
    status_code=201,
    dependencies=_editor_required,
)
async def replay_scan_metrics(
    session: SessionDep,
    slug: str,
    scan_id: uuid.UUID,
    data: ScanMetricsReplayRequest,
) -> ScanJob:
    return await scan_service.trigger_metrics_replay(session, slug, scan_id, data)


@router.get("/{scan_id}/jobs", response_model=list[ScanJobResponse])
async def list_scan_jobs(session: SessionDep, slug: str, scan_id: uuid.UUID) -> list[ScanJob]:
    return await scan_service.list_scan_jobs(session, slug, scan_id)


@router.get("/{scan_id}/jobs/{job_id}", response_model=ScanJobResponse)
async def get_scan_job(
    session: SessionDep,
    slug: str,
    scan_id: uuid.UUID,
    job_id: uuid.UUID,
) -> ScanJob:
    return await scan_service.get_scan_job(session, slug, scan_id, job_id)


@router.post("/{scan_id}/jobs/{job_id}/cancel", response_model=ScanJobResponse)
async def cancel_scan_job(
    session: SessionDep,
    slug: str,
    scan_id: uuid.UUID,
    job_id: uuid.UUID,
    current_user: EditorUserDep,
) -> ScanJob:
    job = await scan_service.cancel_scan_job(session, slug, scan_id, job_id)
    await audit_service.record(
        session,
        user=current_user,
        action="scan_job.cancel",
        target_type="scan_job",
        target_id=job_id,
        target_name=str(job_id),
        project_slug=slug,
    )
    return job
