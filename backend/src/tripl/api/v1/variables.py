import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from tripl.api.deps import CurrentUserDep, SessionDep
from tripl.models.variable import Variable
from tripl.schemas.variable import VariableCreate, VariableResponse, VariableUpdate
from tripl.services import audit_service, variable_service

router = APIRouter(prefix="/projects/{slug}/variables", tags=["variables"])


@router.get("", response_model=list[VariableResponse])
async def list_variables(session: SessionDep, slug: str) -> list[Variable]:
    return await variable_service.list_variables(session, slug)


@router.post("", response_model=VariableResponse, status_code=201)
async def create_variable(
    session: SessionDep,
    slug: str,
    data: VariableCreate,
    current_user: CurrentUserDep,
) -> Variable:
    v = await variable_service.create_variable(session, slug, data)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.create",
        target_type="variable",
        target_id=v.id,
        target_name=v.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return v


@router.patch("/{variable_id}", response_model=VariableResponse)
async def update_variable(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    data: VariableUpdate,
    current_user: CurrentUserDep,
) -> Variable:
    v = await variable_service.update_variable(session, slug, variable_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.update",
        target_type="variable",
        target_id=v.id,
        target_name=v.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return v


@router.delete("/{variable_id}", status_code=204)
async def delete_variable(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    current_user: CurrentUserDep,
) -> None:
    existing = await session.scalar(select(Variable).where(Variable.id == variable_id))
    if existing is None:
        raise HTTPException(status_code=404, detail="Variable not found")
    name = existing.name
    await variable_service.delete_variable(session, slug, variable_id)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.delete",
        target_type="variable",
        target_id=variable_id,
        target_name=name,
        project_slug=slug,
    )
