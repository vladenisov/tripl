import uuid

from fastapi import APIRouter

from tripl.api.deps import BranchIdDep, EditorUserDep, SessionDep
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.schemas.variable import (
    VariableCreate,
    VariableResponse,
    VariableUpdate,
    VariableValueContextResponse,
)
from tripl.services import audit_service, variable_service, variable_value_service

router = APIRouter(prefix="/projects/{slug}/variables", tags=["variables"])


@router.get("", response_model=list[VariableResponse])
async def list_variables(session: SessionDep, slug: str, branch_id: BranchIdDep) -> list[Variable]:
    return await variable_service.list_variables(session, slug, branch_id)


@router.post("", response_model=VariableResponse, status_code=201)
async def create_variable(
    session: SessionDep,
    slug: str,
    data: VariableCreate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> Variable:
    v = await variable_service.create_variable(session, slug, data, branch_id)
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


@router.get("/{variable_id}/values", response_model=list[VariableValueContextResponse])
async def list_variable_values(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    branch_id: BranchIdDep,
) -> list[VariableValue]:
    return await variable_value_service.list_variable_values(session, slug, variable_id, branch_id)


@router.patch("/{variable_id}", response_model=VariableResponse)
async def update_variable(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    data: VariableUpdate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> Variable:
    v = await variable_service.update_variable(session, slug, variable_id, data, branch_id)
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
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> None:
    # Look up via variable_service to enforce branch scope and yield a 404 if missing.
    existing = next(
        (
            v
            for v in await variable_service.list_variables(session, slug, branch_id)
            if v.id == variable_id
        ),
        None,
    )
    name = existing.name if existing else ""
    await variable_service.delete_variable(session, slug, variable_id, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.delete",
        target_type="variable",
        target_id=variable_id,
        target_name=name,
        project_slug=slug,
    )
