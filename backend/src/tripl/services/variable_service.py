import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.variable import Variable
from tripl.schemas.variable import VariableCreate, VariableUpdate
from tripl.services.plan_branch_service import ensure_main_branch_id
from tripl.services.project_service import get_project_id_by_slug


async def list_variables(session: AsyncSession, slug: str) -> list[Variable]:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    result = await session.execute(
        select(Variable)
        .where(Variable.project_id == project_id, Variable.branch_id == branch_id)
        .order_by(Variable.name)
    )
    return list(result.scalars().all())


async def create_variable(session: AsyncSession, slug: str, data: VariableCreate) -> Variable:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    existing = await session.execute(
        select(Variable).where(
            Variable.project_id == project_id,
            Variable.branch_id == branch_id,
            Variable.name == data.name,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Variable with this name already exists")
    var = Variable(**data.model_dump(), project_id=project_id, branch_id=branch_id)
    session.add(var)
    await session.commit()
    await session.refresh(var)
    return var


async def update_variable(
    session: AsyncSession, slug: str, variable_id: uuid.UUID, data: VariableUpdate
) -> Variable:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    result = await session.execute(
        select(Variable).where(
            Variable.id == variable_id,
            Variable.project_id == project_id,
            Variable.branch_id == branch_id,
        )
    )
    var = result.scalar_one_or_none()
    if not var:
        raise HTTPException(status_code=404, detail="Variable not found")
    update_data = data.model_dump(exclude_unset=True)
    if "name" in update_data and update_data["name"] != var.name:
        dup = await session.execute(
            select(Variable).where(
                Variable.project_id == project_id,
                Variable.branch_id == branch_id,
                Variable.name == update_data["name"],
            )
        )
        if dup.scalar_one_or_none():
            raise HTTPException(status_code=409, detail="Variable with this name already exists")

        # Replace ${old_name} → ${new_name} in all event field values for this project
        old_name = var.name
        new_name = update_data["name"]
        old_ref = f"${{{old_name}}}"
        new_ref = f"${{{new_name}}}"

        # Get all event_field_values for events in this project that contain the old ref
        fv_result = await session.execute(
            select(EventFieldValue)
            .join(Event, EventFieldValue.event_id == Event.id)
            .where(
                Event.project_id == project_id,
                Event.branch_id == branch_id,
                EventFieldValue.value.contains(old_ref),
            )
        )
        for fv in fv_result.scalars().all():
            fv.value = fv.value.replace(old_ref, new_ref)

    for key, value in update_data.items():
        setattr(var, key, value)
    await session.commit()
    await session.refresh(var)
    return var


async def delete_variable(session: AsyncSession, slug: str, variable_id: uuid.UUID) -> None:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await ensure_main_branch_id(session, project_id)
    result = await session.execute(
        select(Variable).where(
            Variable.id == variable_id,
            Variable.project_id == project_id,
            Variable.branch_id == branch_id,
        )
    )
    var = result.scalar_one_or_none()
    if not var:
        raise HTTPException(status_code=404, detail="Variable not found")
    await session.delete(var)
    await session.commit()
