import re
import uuid

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.models.variable_value import VariableValue
from tripl.models.variable_value_drift import VariableValueDrift
from tripl.schemas.variable import (
    VariableBulkDelete,
    VariableBulkUpdate,
    VariableCreate,
    VariableEventOverrideUpsert,
    VariableUpdate,
)
from tripl.services import variable_retirement_service
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug
from tripl.services.search_service import reindex_project_branch
from tripl.services.variable_value_service import attach_variable_summaries

# Strict name for NEW names (create + actual renames). Legacy scan-created
# dotted names stay valid as long as they are not being changed.
_STRICT_NAME_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

# Page size used when a caller does not pass one; mirrors the router default so
# service-level callers get the same bounded read as HTTP clients.
DEFAULT_LIST_LIMIT = 200


async def _check_binding_conflicts(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    bindings: list[str],
    exclude_variable_id: uuid.UUID | None = None,
) -> None:
    """409 when a binding is already claimed by another variable in the branch.

    A binding conflicts when another variable carries it in ``bindings`` or as
    its scan identity (``source_name``): scan adoption matches on both, so a
    shared path would make attribution ambiguous.
    """
    if not bindings:
        return
    result = await session.execute(
        select(Variable).where(Variable.project_id == project_id, Variable.branch_id == branch_id)
    )
    wanted = set(bindings)
    for other in result.scalars().all():
        if exclude_variable_id is not None and other.id == exclude_variable_id:
            continue
        taken = set(other.bindings or [])
        if other.source_name:
            taken.add(other.source_name)
        clash = wanted & taken
        if clash:
            raise HTTPException(
                status_code=409,
                detail=f"Binding '{sorted(clash)[0]}' is already used by variable '{other.name}'",
            )


async def list_variables(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID | None = None,
    *,
    offset: int = 0,
    limit: int = DEFAULT_LIST_LIMIT,
    usage: str | None = None,
) -> tuple[list[Variable], int]:
    """One page of the project's variables plus the untruncated total.

    Paging bounds ``attach_variable_summaries`` too: it only ever fans out over
    the ids on the page, never the whole project.

    ``usage="unused"`` narrows the page to exactly the rows the retirement sweep
    would take, and ``"used"`` to its complement. It is answered by the shared
    predicate in ``core.variable_retirement`` rather than by an "``event_count``
    is zero" filter, and the difference is not cosmetic: a variable can have no
    observed context and still be named by a live event's field value — that is
    tripl-xfxa, eighteen rows on production. A cheap zero-count filter would
    have offered precisely those for deletion, from a screen that has a
    select-all checkbox on it.

    The predicate costs one pass over the project's stored field values, so it
    runs only when the filter is actually asked for.
    """
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    scope: list[ColumnElement[bool]] = [
        Variable.project_id == project_id,
        Variable.branch_id == branch_id,
    ]

    if usage in {"used", "unused"}:
        plan = await variable_retirement_service.plan_project_retirement(
            session, project_id=project_id, branch_id=branch_id
        )
        # ``in_(())`` and ``not_in(())`` are both well defined on an empty
        # sequence, so a project with nothing to retire needs no special case:
        # "unused" correctly returns no rows, "used" correctly returns all.
        scope.append(
            Variable.id.in_(plan.retirable)
            if usage == "unused"
            else Variable.id.not_in(plan.retirable)
        )

    total = await session.scalar(select(func.count(Variable.id)).where(*scope)) or 0
    result = await session.execute(
        select(Variable).where(*scope).order_by(Variable.name).offset(offset).limit(limit)
    )
    variables = list(result.scalars().all())
    await attach_variable_summaries(session, variables)
    return variables, total


async def create_variable(
    session: AsyncSession,
    slug: str,
    data: VariableCreate,
    branch_id: uuid.UUID | None = None,
) -> Variable:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    existing = await session.execute(
        select(Variable).where(
            Variable.project_id == project_id,
            Variable.branch_id == branch_id,
            Variable.name == data.name,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Variable with this name already exists")
    await _check_binding_conflicts(
        session, project_id=project_id, branch_id=branch_id, bindings=data.bindings
    )
    var = Variable(**data.model_dump(), project_id=project_id, branch_id=branch_id)
    session.add(var)
    await session.commit()
    await session.refresh(var)
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
    return var


async def update_variable(
    session: AsyncSession,
    slug: str,
    variable_id: uuid.UUID,
    data: VariableUpdate,
    branch_id: uuid.UUID | None = None,
) -> Variable:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
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
    if "bindings" in update_data and update_data["bindings"] is not None:
        await _check_binding_conflicts(
            session,
            project_id=project_id,
            branch_id=branch_id,
            bindings=update_data["bindings"],
            exclude_variable_id=var.id,
        )
    if "name" in update_data and update_data["name"] != var.name:
        if not _STRICT_NAME_PATTERN.match(update_data["name"]):
            raise HTTPException(
                status_code=422,
                detail="Variable names must be lowercase letters, digits and underscores"
                " (bind data paths via 'bindings' instead of dotted names)",
            )
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

    if update_data.get("excluded_from_scans") and not var.excluded_from_scans:
        # Excluding purges the scan-observed side (contexts + drift) but keeps
        # the user-owned documentation (allowed_values, overrides) for restore.
        await session.execute(delete(VariableValue).where(VariableValue.variable_id == var.id))
        await session.execute(
            delete(VariableValueDrift).where(VariableValueDrift.variable_id == var.id)
        )
    for key, value in update_data.items():
        setattr(var, key, value)
    await session.commit()
    await session.refresh(var)
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
    return var


async def delete_variable(
    session: AsyncSession,
    slug: str,
    variable_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> str:
    """Delete one branch-scoped variable and return the name it had.

    Returning the name lets the caller write its audit record without a second
    lookup — the indexed (id, project_id, branch_id) read below is the only one
    the delete path needs.
    """
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    var = await _get_variable_in_branch(session, project_id, branch_id, variable_id)
    name = var.name
    await session.delete(var)
    await session.commit()
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)
    return name


async def _load_variables_by_ids(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    variable_ids: list[uuid.UUID],
) -> list[Variable]:
    result = await session.execute(
        select(Variable).where(
            Variable.project_id == project_id,
            Variable.branch_id == branch_id,
            Variable.id.in_(variable_ids),
        )
    )
    variables = list(result.scalars().all())
    missing = set(variable_ids) - {variable.id for variable in variables}
    if missing:
        raise HTTPException(status_code=404, detail="Variable not found")
    return variables


async def bulk_update_variables(
    session: AsyncSession,
    slug: str,
    data: VariableBulkUpdate,
    branch_id: uuid.UUID | None = None,
) -> None:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    variables = await _load_variables_by_ids(session, project_id, branch_id, data.variable_ids)
    for variable in variables:
        if data.variable_type is not None:
            variable.variable_type = data.variable_type
        if data.description is not None:
            variable.description = data.description
        if data.allowed_values_add or data.allowed_values_remove:
            values = list(variable.allowed_values or [])
            if data.allowed_values_remove:
                removed = set(data.allowed_values_remove)
                values = [value for value in values if value not in removed]
            if data.allowed_values_add:
                seen = set(values)
                for value in data.allowed_values_add:
                    if value not in seen:
                        seen.add(value)
                        values.append(value)
            variable.allowed_values = values
    await session.commit()
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)


async def bulk_delete_variables(
    session: AsyncSession,
    slug: str,
    data: VariableBulkDelete,
    branch_id: uuid.UUID | None = None,
) -> None:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    variables = await _load_variables_by_ids(session, project_id, branch_id, data.variable_ids)
    for variable in variables:
        await session.delete(variable)
    await session.commit()
    await reindex_project_branch(session, project_id=project_id, branch_id=branch_id, slug=slug)


async def _get_variable_in_branch(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    variable_id: uuid.UUID,
) -> Variable:
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
    return var


async def list_event_overrides(
    session: AsyncSession,
    slug: str,
    variable_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> list[VariableEventValueOverride]:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    await _get_variable_in_branch(session, project_id, branch_id, variable_id)
    result = await session.execute(
        select(VariableEventValueOverride)
        .where(
            VariableEventValueOverride.project_id == project_id,
            VariableEventValueOverride.branch_id == branch_id,
            VariableEventValueOverride.variable_id == variable_id,
        )
        .order_by(VariableEventValueOverride.created_at)
    )
    return list(result.scalars().all())


async def upsert_event_override(
    session: AsyncSession,
    slug: str,
    variable_id: uuid.UUID,
    event_id: uuid.UUID,
    data: VariableEventOverrideUpsert,
    branch_id: uuid.UUID | None = None,
) -> VariableEventValueOverride:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    await _get_variable_in_branch(session, project_id, branch_id, variable_id)
    event = await session.execute(
        select(Event).where(
            Event.id == event_id,
            Event.project_id == project_id,
            Event.branch_id == branch_id,
        )
    )
    if not event.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Event not found")
    existing = await session.execute(
        select(VariableEventValueOverride).where(
            VariableEventValueOverride.variable_id == variable_id,
            VariableEventValueOverride.event_id == event_id,
        )
    )
    override = existing.scalar_one_or_none()
    if override is None:
        override = VariableEventValueOverride(
            project_id=project_id,
            branch_id=branch_id,
            variable_id=variable_id,
            event_id=event_id,
            values=list(data.values),
        )
        session.add(override)
    else:
        override.values = list(data.values)
    await session.commit()
    await session.refresh(override)
    return override


async def delete_event_override(
    session: AsyncSession,
    slug: str,
    variable_id: uuid.UUID,
    event_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> None:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    await _get_variable_in_branch(session, project_id, branch_id, variable_id)
    result = await session.execute(
        select(VariableEventValueOverride).where(
            VariableEventValueOverride.variable_id == variable_id,
            VariableEventValueOverride.event_id == event_id,
        )
    )
    override = result.scalar_one_or_none()
    if not override:
        raise HTTPException(status_code=404, detail="Override not found")
    await session.delete(override)
    await session.commit()
