from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.models.event import Event
from tripl.models.field_definition import FieldDefinition
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue, VariableValueKind
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug
from tripl.services.variable_value_drift_service import get_open_drift_counts

SUMMARY_VALUE_LIMIT = 20


def _extend_unique(target: list[str], values: Iterable[str], *, limit: int) -> None:
    seen = set(target)
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        target.append(value)
        if len(target) >= limit:
            break


async def attach_variable_summaries(
    session: AsyncSession,
    variables: list[Variable],
) -> None:
    variable_ids = [variable.id for variable in variables]
    if not variable_ids:
        return

    rows = await session.execute(
        select(VariableValue).where(VariableValue.variable_id.in_(variable_ids))
    )
    contexts = list(rows.scalars().all())
    event_ids_by_variable: dict[uuid.UUID, set[uuid.UUID]] = defaultdict(set)
    context_counts: dict[uuid.UUID, int] = defaultdict(int)
    low_counts: dict[uuid.UUID, int] = defaultdict(int)
    high_counts: dict[uuid.UUID, int] = defaultdict(int)
    sample_values: dict[uuid.UUID, list[str]] = defaultdict(list)

    for context in contexts:
        event_ids_by_variable[context.variable_id].add(context.event_id)
        context_counts[context.variable_id] += 1
        if context.value_kind == VariableValueKind.low.value:
            low_counts[context.variable_id] += 1
        else:
            high_counts[context.variable_id] += 1
        _extend_unique(
            sample_values[context.variable_id],
            context.values or [],
            limit=SUMMARY_VALUE_LIMIT,
        )

    drift_counts = await get_open_drift_counts(session, variable_ids)

    for variable in variables:
        variable.event_count = len(event_ids_by_variable.get(variable.id, set()))  # type: ignore[attr-defined]
        variable.context_count = context_counts.get(variable.id, 0)  # type: ignore[attr-defined]
        variable.low_context_count = low_counts.get(variable.id, 0)  # type: ignore[attr-defined]
        variable.high_context_count = high_counts.get(variable.id, 0)  # type: ignore[attr-defined]
        variable.sample_values = sample_values.get(variable.id, [])  # type: ignore[attr-defined]
        variable.open_drift_count = drift_counts.get(variable.id, 0)  # type: ignore[attr-defined]


async def list_variable_values(
    session: AsyncSession,
    slug: str,
    variable_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> list[VariableValue]:
    project_id = await get_project_id_by_slug(session, slug)
    branch_id = await resolve_branch_id(session, project_id, branch_id)
    variable = await session.scalar(
        select(Variable).where(
            Variable.id == variable_id,
            Variable.project_id == project_id,
            Variable.branch_id == branch_id,
        )
    )
    if variable is None:
        raise HTTPException(status_code=404, detail="Variable not found")

    rows = await session.execute(
        select(VariableValue)
        .join(Event, VariableValue.event_id == Event.id)
        .join(FieldDefinition, VariableValue.field_definition_id == FieldDefinition.id)
        .where(
            VariableValue.project_id == project_id,
            VariableValue.branch_id == branch_id,
            VariableValue.variable_id == variable_id,
        )
        .options(
            selectinload(VariableValue.variable),
            selectinload(VariableValue.event),
            selectinload(VariableValue.field_definition),
        )
        .order_by(Event.name.asc(), FieldDefinition.order.asc(), FieldDefinition.name.asc())
    )
    return list(rows.scalars().all())


async def attach_event_field_variable_values(
    session: AsyncSession,
    events: list[Event],
) -> None:
    event_ids = [event.id for event in events]
    if not event_ids:
        return

    rows = await session.execute(
        select(VariableValue)
        .where(VariableValue.event_id.in_(event_ids))
        .options(selectinload(VariableValue.variable))
    )
    contexts_by_field: dict[tuple[uuid.UUID, uuid.UUID], list[VariableValue]] = defaultdict(list)
    for context in rows.scalars().all():
        contexts_by_field[(context.event_id, context.field_definition_id)].append(context)

    for event in events:
        for field_value in event.field_values:
            field_value.variable_values = contexts_by_field.get(  # type: ignore[attr-defined]
                (event.id, field_value.field_definition_id),
                [],
            )
