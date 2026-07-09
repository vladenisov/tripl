"""Detection of observed variable values outside the documented lists.

Runs inside the scan's ``generate_events`` right after variable contexts are
rebuilt. Purely additive to the plan: rows are upserted on
``(variable_id, event_id)`` refreshing ``observed_values``/``detected_at`` and
NEVER touching ``status`` — accepted/false-positive resolutions survive
rescans and age out via the read-time retention window (30 days, mirroring
schema drift).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.models.variable_value_drift import VariableValueDrift

NOVEL_VALUE_SAMPLE_LIMIT = 20


def detect_variable_value_drifts(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    scan_config_id: uuid.UUID | None,
    contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]],
) -> int:
    """Upsert drift rows for observed values missing from documented lists.

    ``contexts`` is the in-memory (variable_id, event_id, field_definition_id)
    → payload map that ``generate_events`` just persisted. The documented list
    for a (variable, event) pair is the per-event override when one exists,
    else the variable's global ``allowed_values``; an empty documented list
    means "no contract" and produces no drift. Returns the number of
    (variable, event) pairs with novel values this run.
    """
    if not contexts:
        return 0

    variable_ids = {variable_id for variable_id, _, _ in contexts}
    event_ids = {event_id for _, event_id, _ in contexts}

    variables_by_id: dict[uuid.UUID, Variable] = {
        variable.id: variable
        for variable in session.execute(
            select(Variable).where(Variable.id.in_(variable_ids))
        ).scalars()
    }
    override_query = select(VariableEventValueOverride).where(
        VariableEventValueOverride.project_id == project_id,
        VariableEventValueOverride.variable_id.in_(variable_ids),
        VariableEventValueOverride.event_id.in_(event_ids),
    )
    if branch_id is not None:
        override_query = override_query.where(VariableEventValueOverride.branch_id == branch_id)
    overrides: dict[tuple[uuid.UUID, uuid.UUID], list[str]] = {
        (override.variable_id, override.event_id): list(override.values or [])
        for override in session.execute(override_query).scalars()
    }

    novel_by_pair: dict[tuple[uuid.UUID, uuid.UUID], list[str]] = {}
    for (variable_id, event_id, _), context in contexts.items():
        variable = variables_by_id.get(variable_id)
        if variable is None:
            continue
        documented = overrides.get((variable_id, event_id), list(variable.allowed_values or []))
        if not documented:
            continue
        documented_set = set(documented)
        novel = novel_by_pair.setdefault((variable_id, event_id), [])
        for value in context.get("values") or []:
            if value not in documented_set and value not in novel:
                novel.append(value)

    rows = [
        {
            "id": uuid.uuid4(),
            "project_id": project_id,
            "variable_id": variable_id,
            "event_id": event_id,
            "scan_config_id": scan_config_id,
            "observed_values": novel[:NOVEL_VALUE_SAMPLE_LIMIT],
            "detected_at": datetime.now(UTC),
        }
        for (variable_id, event_id), novel in novel_by_pair.items()
        if novel
    ]
    if not rows:
        return 0

    refresh_columns = ("scan_config_id", "observed_values", "detected_at")
    if session.bind is not None and session.bind.dialect.name == "sqlite":
        sqlite_stmt = sqlite_insert(VariableValueDrift).values(rows)
        sqlite_stmt = sqlite_stmt.on_conflict_do_update(
            index_elements=["variable_id", "event_id"],
            set_={column: getattr(sqlite_stmt.excluded, column) for column in refresh_columns},
        )
        session.execute(sqlite_stmt)
        return len(rows)

    pg_stmt = pg_insert(VariableValueDrift).values(rows)
    pg_stmt = pg_stmt.on_conflict_do_update(
        constraint="uq_variable_value_drift_context",
        set_={column: getattr(pg_stmt.excluded, column) for column in refresh_columns},
    )
    session.execute(pg_stmt)
    return len(rows)
