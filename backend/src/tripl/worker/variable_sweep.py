"""Retire the variables a project no longer refers to, at the end of a scan.

The scan is what mints variables, so the scan is where they should stop
accumulating. Without this the catalog only ever grows: production's
``windy-ios`` reached 1517 variables of which 1296 were referenced by nothing,
1279 of them minted from the keys of one JSON map column (tripl-10h4).

The predicate is :mod:`tripl.core.variable_retirement`, shared verbatim with the
owner-facing danger-zone endpoint. Only the queries differ — that module runs on
an ``AsyncSession`` and this one on the worker's sync ``Session`` — and that
split is the same one every other pair in this package lives with.

**This does not undo the run that just finished.** A variable minted by that run
had its token written into at least one event's field value by the same run — a
path enters ``all_paths`` only by appearing in a row, and that row's event
stores ``${col.path}`` — so the reference check keeps it. What the sweep removes
is the row whose token has since disappeared from every stored value, which is
exactly the fossil.

One case does mint and sweep in the same run, and it is the right answer rather
than an exception to apologise for: a path carried *only* by an ARCHIVED event.
A scan deliberately leaves an archived row's field values alone (tripl-rsei), so
the token is never written and nothing live refers to the variable.

Runs after the scan's ``session.commit()`` and before the search reindex, so the
reindex sees the retired set and the deletions cannot be rolled back by a later
failure in the same task.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import delete, select
from sqlalchemy.orm import InstrumentedAttribute, Session

from tripl.core.variable_retirement import plan_retirement, referenced_tokens
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_meta_value import EventMetaValue
from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.models.variable_value import VariableValue
from tripl.models.variable_value_drift import VariableValueDrift

logger = logging.getLogger(__name__)

# Mirrors ``variable_retirement_service._DELETE_BATCH``: PostgreSQL caps a
# statement at 65535 bind parameters and the retirable set is unbounded by
# construction — it is the population this code exists because nothing bounded.
_DELETE_BATCH = 1000


def _ids_with_rows(
    session: Session,
    column: InstrumentedAttribute[uuid.UUID],
    variable_ids: list[uuid.UUID],
) -> set[uuid.UUID]:
    if not variable_ids:
        return set()
    return set(session.execute(select(column).where(column.in_(variable_ids)).distinct()).scalars())


def retire_unused_variables(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
) -> int:
    """Delete the project branch's unreferenced scan-created variables.

    Returns the number retired, for the scan's own report. Commits only when it
    deleted something, so a scan over a healthy catalog costs four reads and no
    write at all.
    """
    scope = [Variable.project_id == project_id]
    value_scope = [Event.project_id == project_id]
    if branch_id is not None:
        scope.append(Variable.branch_id == branch_id)
        value_scope.append(Event.branch_id == branch_id)

    variables = list(session.execute(select(Variable).where(*scope)).scalars())
    if not variables:
        return 0

    # BOTH value tables — see the note in ``variable_retirement_service``. A
    # ``${token}`` is legal in an event's field values and in its META values,
    # and only the first produces a ``VariableValue`` context, so reading field
    # values alone would retire a variable referenced solely from a meta value.
    values = [
        *session.execute(
            select(EventFieldValue.value)
            .join(Event, EventFieldValue.event_id == Event.id)
            .where(*value_scope)
        ).scalars(),
        *session.execute(
            select(EventMetaValue.value)
            .join(Event, EventMetaValue.event_id == Event.id)
            .where(*value_scope)
        ).scalars(),
    ]

    variable_ids = [variable.id for variable in variables]
    plan = plan_retirement(
        variables,
        referenced=referenced_tokens(values),
        with_contexts=_ids_with_rows(session, VariableValue.variable_id, variable_ids),
        with_drifts=_ids_with_rows(session, VariableValueDrift.variable_id, variable_ids),
        with_overrides=_ids_with_rows(
            session, VariableEventValueOverride.variable_id, variable_ids
        ),
    )
    if not plan.retirable:
        return 0

    for start in range(0, len(plan.retirable), _DELETE_BATCH):
        batch = plan.retirable[start : start + _DELETE_BATCH]
        session.execute(
            delete(Variable)
            .where(Variable.id.in_(batch))
            .execution_options(synchronize_session=False)
        )
    session.commit()
    logger.info(
        "Retired unreferenced scan-created variables",
        extra={
            "project_id": str(project_id),
            "retired": len(plan.retirable),
            "scanned": plan.scanned,
        },
    )
    return len(plan.retirable)
