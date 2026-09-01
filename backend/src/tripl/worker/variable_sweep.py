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

**The caller must have judged cardinality over a view it can defend.** "Nothing
refers to this" is a claim about the whole project, and the run that answers it
reads the field values its own catalog pass has just rewritten. Rewrite them
from a view that is too narrow and the sweep destroys the evidence it is reading:
``event_plan.plan_column_meta`` sets ``meta['is_low']`` from the cardinality of
the window it was given, ``plan_events`` then emits a LITERAL instead of the
``${token}`` template (``event_plan`` L485-491), ``_upsert_field_values``
rewrites the stored value in place, and
``delete_variable_contexts_for_event_type`` drops that field's contexts because
the run rewrote it. The variable is left with no stored token and no context —
retirable by this predicate — and its whole observed-value history goes with the
row. ``run_scan`` is safe because an unset ``scan_lookback_hours`` leaves its
window ``None`` and it sees the whole table; ``collect_metrics`` is not, because
it falls back to the collection window (one or two intervals) and a column that
is high-cardinality over the table can read low over one hour. So the scheduled
caller sweeps only when the operator DECLARED the catalog window (tripl-bh1q
follow-up); see ``collect_metrics`` for the gate itself.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import Select, delete, select
from sqlalchemy.orm import InstrumentedAttribute, Session, lazyload

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


def retired_details_line(count: int) -> str:
    """The one sentence both worker call sites report a sweep with.

    Lives here rather than at either call site because ``collect_metrics`` now
    says it TWICE — once on the stub it stamps the moment the delete is durable,
    once in the full summary it assembles ~400 lines later — and ``run_scan``
    says it a third time. An operator comparing a scheduled run against a manual
    one must not be left deciding whether two phrasings mean the same thing.
    """
    return f"Retired {count} unused variables no event refers to"


def _ids_with_rows(
    session: Session,
    column: InstrumentedAttribute[uuid.UUID],
    scoped_variable_ids: Select[tuple[uuid.UUID]],
) -> set[uuid.UUID]:
    """See ``variable_retirement_service._variable_ids_with_rows``.

    A SUBQUERY, not the loaded id list: the population is unbounded by
    construction and PostgreSQL caps a statement at 65535 bind parameters, so a
    literal ``IN`` here would put on the reads exactly the ceiling
    ``_DELETE_BATCH`` keeps off the writes.
    """
    return set(
        session.execute(select(column).where(column.in_(scoped_variable_ids)).distinct()).scalars()
    )


def retire_unused_variables(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
) -> int:
    """Delete the project branch's unreferenced scan-created variables.

    Returns the number of rows this call ACTUALLY deleted, for the scan's own
    report — summed from the statements' rowcounts, not from the length of the
    plan. The two differ whenever a concurrent run got there first, and that is
    not a rare shape: the sweep is project-wide but this task is per-config, and
    ``check_metrics_due`` dispatches every due config as an independent Celery
    task with no project-level lock (its advisory lock serialises the DISPATCH
    loop, and ``_get_active_scan_jobs`` is checked per config). Two configs of
    one project on the same interval therefore run in parallel, both compute the
    same retirable set, and the second ``DELETE`` matches zero rows — so
    reporting ``len(plan.retirable)`` had both runs claim the full count, in the
    summary and in the log.

    Commits only when it had something to delete, so a scan over a healthy
    catalog costs four reads and no write at all.
    """
    scope = [Variable.project_id == project_id]
    value_scope = [Event.project_id == project_id]
    if branch_id is not None:
        scope.append(Variable.branch_id == branch_id)
        value_scope.append(Event.branch_id == branch_id)

    # ``lazyload`` for the same reason as ``catalog_sync`` and the two request-path
    # selects: ``Variable.value_contexts`` is ``lazy="selectin"`` and each context
    # then selectin-loads its FieldDefinition, so hydrating these plainly pulls the
    # project's entire context table into a sweep that only ever reads ids, names
    # and provenance. The contexts are answered by the anti-join below instead
    # (tripl-xkbb).
    variables = list(
        session.execute(
            select(Variable).where(*scope).options(lazyload(Variable.value_contexts))
        ).scalars()
    )
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

    scoped_ids = select(Variable.id).where(*scope)
    plan = plan_retirement(
        variables,
        referenced=referenced_tokens(values),
        with_contexts=_ids_with_rows(session, VariableValue.variable_id, scoped_ids),
        with_drifts=_ids_with_rows(session, VariableValueDrift.variable_id, scoped_ids),
        with_overrides=_ids_with_rows(session, VariableEventValueOverride.variable_id, scoped_ids),
    )
    if not plan.retirable:
        return 0

    # Batching is unchanged — PostgreSQL's 65535-bind-parameter ceiling is the
    # reason for it and that has not moved. What changed is that each statement's
    # rowcount is now read and summed, so a batch that raced another run and
    # matched nothing contributes nothing.
    retired = 0
    for start in range(0, len(plan.retirable), _DELETE_BATCH):
        batch = plan.retirable[start : start + _DELETE_BATCH]
        result = session.execute(
            delete(Variable)
            .where(Variable.id.in_(batch))
            .execution_options(synchronize_session=False)
        )
        rowcount = getattr(result, "rowcount", 0)
        retired += int(rowcount or 0)
    session.commit()
    # Both numbers, always: ``planned`` short of ``retired`` is the signature of
    # the concurrent sibling config described in the docstring, and a log line
    # carrying only one of them cannot tell that apart from a quiet catalog.
    logger.info(
        "Retired unreferenced scan-created variables",
        extra={
            "project_id": str(project_id),
            "retired": retired,
            "planned": len(plan.retirable),
            "scanned": plan.scanned,
        },
    )
    return retired
