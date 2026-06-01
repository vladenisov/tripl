from fastapi import APIRouter, Depends

from tripl.api.deps import SessionDep, get_editor_user
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.schemas.project_anomaly_settings import (
    ProjectAnomalySettingsResponse,
    ProjectAnomalySettingsUpdate,
)
from tripl.services import project_anomaly_settings_service

router = APIRouter(
    prefix="/projects/{slug}/anomaly-settings",
    tags=["anomaly-settings"],
)
_editor_required = [Depends(get_editor_user)]


@router.get("", response_model=ProjectAnomalySettingsResponse)
async def get_project_anomaly_settings(session: SessionDep, slug: str) -> ProjectAnomalySettings:
    return await project_anomaly_settings_service.get_project_anomaly_settings(session, slug)


@router.patch(
    "",
    response_model=ProjectAnomalySettingsResponse,
    dependencies=_editor_required,
)
async def update_project_anomaly_settings(
    session: SessionDep,
    slug: str,
    data: ProjectAnomalySettingsUpdate,
) -> ProjectAnomalySettings:
    return await project_anomaly_settings_service.update_project_anomaly_settings(
        session,
        slug,
        data,
    )
