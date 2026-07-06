from fastapi import APIRouter

from tripl.api.deps import OwnerUserDep, SessionDep
from tripl.schemas.project_tracker_config import (
    ProjectTrackerConfigResponse,
    ProjectTrackerConfigUpdate,
)
from tripl.services import audit_service, project_tracker_config_service

router = APIRouter(
    prefix="/projects/{slug}/tracker-config",
    tags=["tracker-config"],
)


@router.get("", response_model=ProjectTrackerConfigResponse)
async def get_project_tracker_config(
    session: SessionDep, slug: str
) -> ProjectTrackerConfigResponse:
    return await project_tracker_config_service.get_project_tracker_config(session, slug)


@router.patch("", response_model=ProjectTrackerConfigResponse)
async def update_project_tracker_config(
    session: SessionDep,
    current_user: OwnerUserDep,
    slug: str,
    data: ProjectTrackerConfigUpdate,
) -> ProjectTrackerConfigResponse:
    """Owner-only: the tracker config stores an API token and drives outbound
    ticket creation, so editors must not be able to point it at their own Jira."""
    config = await project_tracker_config_service.update_project_tracker_config(
        session,
        slug,
        data,
    )
    # NEVER audit the raw token — drop it from the recorded payload.
    audit_payload = data.model_dump(exclude_unset=True, exclude_none=True)
    audit_payload.pop("api_token", None)
    await audit_service.record(
        session,
        user=current_user,
        action="project_tracker_config.update",
        target_type="project_tracker_config",
        target_id=config.id,
        target_name=slug,
        project_slug=slug,
        payload=audit_payload,
    )
    return config
