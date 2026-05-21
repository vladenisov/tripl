from fastapi import APIRouter, Depends

from tripl.api.deps import SessionDep, get_editor_user
from tripl.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate
from tripl.services import project_service

router = APIRouter(prefix="/projects", tags=["projects"])

_editor_required = [Depends(get_editor_user)]


@router.get("", response_model=list[ProjectResponse])
async def list_projects(session: SessionDep) -> list[ProjectResponse]:
    return await project_service.list_projects(session)


@router.post(
    "",
    response_model=ProjectResponse,
    status_code=201,
    dependencies=_editor_required,
)
async def create_project(session: SessionDep, data: ProjectCreate) -> ProjectResponse:
    return await project_service.create_project(session, data)


@router.get("/{slug}", response_model=ProjectResponse)
async def get_project(session: SessionDep, slug: str) -> ProjectResponse:
    return await project_service.get_project(session, slug)


@router.patch(
    "/{slug}",
    response_model=ProjectResponse,
    dependencies=_editor_required,
)
async def update_project(session: SessionDep, slug: str, data: ProjectUpdate) -> ProjectResponse:
    return await project_service.update_project(session, slug, data)


@router.delete("/{slug}", status_code=204, dependencies=_editor_required)
async def delete_project(session: SessionDep, slug: str) -> None:
    await project_service.delete_project(session, slug)
