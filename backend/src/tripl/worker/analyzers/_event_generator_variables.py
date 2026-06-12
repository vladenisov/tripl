"""Variable detection, creation, and context recording for event generation."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tripl.models.event import Event
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue, VariableValueKind

logger = logging.getLogger(__name__)

VARIABLE_VALUE_SAMPLE_LIMIT = 20


@dataclass(frozen=True)
class VariableObservation:
    name: str
    source_column: str
    value_kind: str
    observed_count: int
    values: list[str]


def sample_variable_values(values: Sequence[str], value_kind: str) -> list[str]:
    seen: set[str] = set()
    unique_values: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        unique_values.append(value)
    if value_kind == VariableValueKind.low.value:
        return unique_values
    return unique_values[:VARIABLE_VALUE_SAMPLE_LIMIT]


def variable_observations(col_meta: dict[str, dict[str, Any]]) -> list[VariableObservation]:
    observations: list[VariableObservation] = []
    for meta in col_meta.values():
        observations.extend(meta.get("variable_observations") or [])
    return observations


def load_variables_for_contexts(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    col_meta: dict[str, dict[str, Any]],
) -> dict[str, Variable]:
    names = {observation.name for observation in variable_observations(col_meta)}
    if not names:
        return {}
    query = select(Variable).where(
        Variable.project_id == project_id,
        or_(Variable.name.in_(names), Variable.source_name.in_(names)),
    )
    if branch_id is not None:
        query = query.where(Variable.branch_id == branch_id)
    variables = session.execute(query).scalars().all()
    variable_by_token: dict[str, Variable] = {}
    for variable in variables:
        if variable.source_name in names:
            variable_by_token.setdefault(variable.source_name, variable)
        if variable.name in names:
            variable_by_token.setdefault(variable.name, variable)
    return variable_by_token


def delete_variable_contexts_for_event_type(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    event_type_id: uuid.UUID,
) -> None:
    event_ids = select(Event.id).where(
        Event.project_id == project_id,
        Event.event_type_id == event_type_id,
    )
    if branch_id is not None:
        event_ids = event_ids.where(Event.branch_id == branch_id)
    delete_query = delete(VariableValue).where(
        VariableValue.project_id == project_id,
        VariableValue.event_id.in_(event_ids),
    )
    if branch_id is not None:
        delete_query = delete_query.where(VariableValue.branch_id == branch_id)
    session.execute(delete_query)


def preserve_existing_variable_context_values(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]],
) -> None:
    if not contexts:
        return

    variable_ids = {variable_id for variable_id, _, _ in contexts}
    event_ids = {event_id for _, event_id, _ in contexts}
    field_definition_ids = {field_id for _, _, field_id in contexts}
    query = select(VariableValue).where(
        VariableValue.project_id == project_id,
        VariableValue.variable_id.in_(variable_ids),
        VariableValue.event_id.in_(event_ids),
        VariableValue.field_definition_id.in_(field_definition_ids),
    )
    if branch_id is not None:
        query = query.where(VariableValue.branch_id == branch_id)

    existing_contexts = session.execute(query).scalars().all()
    for existing in existing_contexts:
        key = (existing.variable_id, existing.event_id, existing.field_definition_id)
        context = contexts.get(key)
        if context is None:
            continue

        context_values = list(context.get("values") or [])
        existing_values = list(existing.values or [])
        if not context_values and existing_values:
            context["values"] = sample_variable_values(existing_values, existing.value_kind)

        context["observed_count"] = max(
            int(context.get("observed_count") or 0),
            existing.observed_count,
            len(context.get("values") or []),
        )
        if existing.value_kind == VariableValueKind.high.value:
            context["value_kind"] = VariableValueKind.high.value


def record_variable_contexts(
    contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]],
    *,
    event: Event,
    field_values: Sequence[tuple[uuid.UUID, str, str]],
    col_meta: dict[str, dict[str, Any]],
    variable_by_token: dict[str, Variable],
) -> None:
    for field_definition_id, col_name, value in field_values:
        observations: list[VariableObservation] = (
            col_meta.get(col_name, {}).get("variable_observations") or []
        )
        if not observations:
            continue
        for observation in observations:
            if f"${{{observation.name}}}" not in value:
                continue
            variable = variable_by_token.get(observation.name)
            if variable is None:
                continue
            key = (variable.id, event.id, field_definition_id)
            existing = contexts.get(key)
            if existing is None:
                contexts[key] = {
                    "variable_id": variable.id,
                    "event_id": event.id,
                    "field_definition_id": field_definition_id,
                    "source_column": observation.source_column,
                    "value_kind": observation.value_kind,
                    "observed_count": observation.observed_count,
                    "values": list(observation.values),
                }
                continue

            existing["observed_count"] = max(
                int(existing["observed_count"]),
                observation.observed_count,
            )
            if observation.value_kind == VariableValueKind.high.value:
                existing["value_kind"] = VariableValueKind.high.value
            existing["values"] = sample_variable_values(
                [*existing["values"], *observation.values],
                existing["value_kind"],
            )


def insert_variable_contexts(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]],
) -> None:
    for context in contexts.values():
        payload = {
            "id": uuid.uuid4(),
            "project_id": project_id,
            "variable_id": context["variable_id"],
            "event_id": context["event_id"],
            "field_definition_id": context["field_definition_id"],
            "source_column": context["source_column"],
            "value_kind": context["value_kind"],
            "observed_count": context["observed_count"],
            "values": context["values"],
        }
        if branch_id is not None:
            payload["branch_id"] = branch_id
        session.add(VariableValue(**payload))


def resolve_main_branch_id(session: Session, project_id: uuid.UUID) -> uuid.UUID | None:
    """Return the project's existing main-branch id, or ``None`` if not created yet.

    Scans write plan entities to the main branch (see ``default_branch_id``).
    Variable uniqueness is enforced per branch — ``(project_id, branch_id,
    source_name)`` — so the working copies a project's plan branches hold can
    legitimately share a ``source_name``. Scoping the scan's existence checks to
    the main branch keeps that constraint meaningful and stops a same-name row on
    another branch from making the lookup raise ``MultipleResultsFound``.
    """
    return (
        session.execute(
            select(PlanBranch.id).where(
                PlanBranch.project_id == project_id,
                PlanBranch.kind == BranchKind.main.value,
            )
        )
        .scalars()
        .first()
    )


def ensure_variable(
    session: Session,
    project_id: uuid.UUID,
    name: str,
    inferred_type: str,
    branch_id: uuid.UUID | None = None,
) -> int:
    """Create a Variable if it doesn't exist. Returns 1 if created, 0 if already exists.

    Looks up by source_name (the original scan-detected name) so that
    user renames of the display ``name`` don't cause duplicates. Lookups are
    scoped to ``branch_id`` (the scan's main branch) so a same-named variable on
    another plan branch is not treated as an existing match — without that scope
    the query spans branches and can match more than one row.
    """
    source_query = select(Variable).where(
        Variable.project_id == project_id,
        Variable.source_name == name,
    )
    if branch_id is not None:
        source_query = source_query.where(Variable.branch_id == branch_id)
    existing = session.execute(source_query).scalars().first()

    if existing is not None:
        return 0

    # Also check by name (covers manually created variables)
    name_query = select(Variable).where(
        Variable.project_id == project_id,
        Variable.name == name,
    )
    if branch_id is not None:
        name_query = name_query.where(Variable.branch_id == branch_id)
    existing_by_name = session.execute(name_query).scalars().first()

    if existing_by_name is not None:
        # Backfill source_name if missing
        if existing_by_name.source_name is None:
            existing_by_name.source_name = name
            session.flush()
        return 0

    var = Variable(
        id=uuid.uuid4(),
        project_id=project_id,
        name=name,
        source_name=name,
        variable_type=inferred_type,
        description="Auto-detected variable from data source scan",
    )
    if branch_id is not None:
        var.branch_id = branch_id
    # Race-safe insert: two concurrent scan workers can discover the same
    # variable in the same bucket and attempt to insert simultaneously.
    # Keep this operation isolated in a SAVEPOINT so an IntegrityError does not
    # poison the outer transaction.
    try:
        with session.begin_nested():
            session.add(var)
            session.flush()
    except IntegrityError:
        logger.info(
            "Variable already inserted concurrently; skipping duplicate",
            extra={"project_id": str(project_id), "name": name, "branch_id": str(branch_id)},
        )
        return 0
    return 1
