"""Generate events from breakdown analysis results.

Takes breakdown analysis (per-column cardinality stats + raw GROUP BY ALL rows)
and produces deduplicated Event + EventFieldValue records.  Each breakdown row
maps to one event, preserving actual column correlations from the data.

Implementation is split across three sibling modules:

* ``event_plan``                  — the PURE half: which events a breakdown
  would produce, and under which names. Shared verbatim with the dry-run so a
  preview cannot drift from what a real run does
* ``_event_generator_variables``  — variable detection, creation, context ops
* ``_event_generator_merge``      — grouping rules, merge/consolidation logic

What is left here is exactly the part that needs a ``Session``: turning the plan
into rows, ensuring variables exist, recording variable contexts, and merging.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tripl.core.analyzers._event_generator_merge import (
    EventGroupMatch,
    _merge_existing_grouped_events,
    apply_event_group_rules,
    merge_existing_events_for_group_rules,
)
from tripl.core.analyzers._event_generator_variables import (
    VariableObservation,
)
from tripl.core.analyzers._event_generator_variables import (
    build_variable_index as _build_variable_index,
)
from tripl.core.analyzers._event_generator_variables import (
    delete_variable_contexts_for_event_type as _delete_variable_contexts_for_event_type,
)
from tripl.core.analyzers._event_generator_variables import (
    ensure_variable as _ensure_variable,
)
from tripl.core.analyzers._event_generator_variables import (
    insert_variable_contexts as _insert_variable_contexts,
)
from tripl.core.analyzers._event_generator_variables import (
    normalize_variable_tokens as _normalize_variable_tokens,
)
from tripl.core.analyzers._event_generator_variables import (
    preserve_existing_variable_context_values as _preserve_existing_variable_context_values,
)
from tripl.core.analyzers._event_generator_variables import (
    record_variable_contexts as _record_variable_contexts,
)
from tripl.core.analyzers._event_generator_variables import (
    resolve_main_branch_id as _resolve_main_branch_id,
)
from tripl.core.analyzers._variable_value_drift import (
    detect_variable_value_drifts as _detect_variable_value_drifts,
)
from tripl.core.analyzers.cardinality import BreakdownAnalysis
from tripl.core.analyzers.event_plan import (
    _NAME_FORMAT_ERROR_BUDGET,
    DEFAULT_MAX_EVENTS,
    EventPlan,
    PlannedEvent,
    VariableNeed,
    _apply_name_format,
    _format_value,
    event_name_format_columns,
    name_format_base_columns,
    plan_column_meta,
    plan_events,
)
from tripl.models.event import Event, EventStatus
from tripl.models.event_field_value import EventFieldValue
from tripl.models.field_definition import FieldDefinition

logger = logging.getLogger(__name__)

VARIABLE_VALUE_SAMPLE_LIMIT = 20

# Re-export public names that callers import directly from this module.
#
# ``_apply_name_format`` / ``_format_value`` / ``_NAME_FORMAT_ERROR_BUDGET`` now
# live in ``event_plan`` (they are pure and the planner needs them), but
# ``worker.tasks.metrics.metric_rows`` and ``test_name_format_errors`` import
# them from here. Re-binding keeps those imports working and keeps ONE
# definition, which is the whole point of the split.
__all__ = [
    "DEFAULT_MAX_EVENTS",
    "EventGroupMatch",
    "EventPlan",
    "GenerationResult",
    "PlannedEvent",
    "VariableNeed",
    "VariableObservation",
    "_NAME_FORMAT_ERROR_BUDGET",
    "_apply_name_format",
    "_ensure_variable",
    "_format_value",
    "_resolve_main_branch_id",
    "apply_event_group_rules",
    "event_name_format_columns",
    "generate_events",
    "merge_existing_events_for_group_rules",
    "name_format_base_columns",
    "plan_column_meta",
    "plan_events",
]


@dataclass
class GenerationResult:
    event_type_id: uuid.UUID | None = None
    events_created: int = 0
    events_skipped: int = 0
    events_grouped: int = 0
    events_merged: int = 0
    variables_created: int = 0
    value_drifts_detected: int = 0
    columns_analyzed: int = 0
    details: list[str] = field(default_factory=list)
    col_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    events_by_name: dict[str, Event] = field(default_factory=dict)
    # Scan identities of ARCHIVED events, deliberately kept out of
    # ``events_by_name`` so nothing collects metrics for them. The collector
    # still needs them by name to tell "put away" apart from "never planned":
    # without this an archived identity misses ``events_by_name``, is filed as a
    # shadow candidate, and its volume lands in the coverage denominator but not
    # the numerator — so archiving a busy event tanks coverage (tripl-w3ms).
    archived_identities: set[str] = field(default_factory=set)
    snapshot: dict[str, Any] | None = None


def generate_events(
    session: Session,
    project_id: uuid.UUID,
    event_type_id: uuid.UUID,
    analysis: BreakdownAnalysis,
    field_definitions: dict[str, FieldDefinition],
    cardinality_threshold: int = 100,
    event_type_column: str | None = None,
    time_column: str | None = None,
    event_name_format: str | None = None,
    event_group_rules: Sequence[Mapping[str, object]] | None = None,
    reserved_columns: Collection[str] | None = None,
    max_events: int = DEFAULT_MAX_EVENTS,
    scan_config_id: uuid.UUID | None = None,
) -> GenerationResult:
    """Generate events from breakdown analysis.

    Each row from the GROUP BY ALL breakdown becomes one event.
    Low-cardinality columns use actual values from the row,
    high-cardinality columns use detected templates with ${var} placeholders,
    JSON columns use their actual path combo from the row.

    Which events those are, and what they are called, is decided by
    ``event_plan.plan_events`` — the same function the dry-run calls, so a
    preview cannot promise names a run would not produce. Everything below the
    plan is persistence.
    """
    result = GenerationResult()
    # The scan writes to the project's main branch (Variable inserts default
    # ``branch_id`` to it); resolve it once so variable existence checks are
    # scoped to the same branch (see ``_ensure_variable``).
    main_branch_id = _resolve_main_branch_id(session, project_id)
    # One token→variable index for the whole run: scan adoption (by name,
    # source_name or user-editable binding), context attribution and token
    # normalization all resolve through it.
    variable_index = _build_variable_index(session, project_id=project_id, branch_id=main_branch_id)

    plan = plan_events(
        analysis,
        {name: fd.id for name, fd in field_definitions.items()},
        cardinality_threshold=cardinality_threshold,
        event_type_column=event_type_column,
        time_column=time_column,
        event_name_format=event_name_format,
        event_group_rules=event_group_rules,
        reserved_columns=reserved_columns,
        # Deliberately uncapped. ``max_events`` bounds the events this function
        # CREATES; the planner can only bound distinct names, and a re-scan whose
        # names all exist already creates none of them. Capping in the planner
        # would silently stop refreshing field values on row 10001 of a scan that
        # creates nothing at all. The dry-run, which has no such distinction,
        # passes the cap to the planner instead.
    )
    result.details.extend(plan.details)
    result.columns_analyzed = plan.columns_analyzed
    # Hoisted out of the column loop by the plan/persist split, in first-seen
    # order — ``_ensure_variable`` creates a variable with the FIRST type it is
    # asked for and registers it on the index, so the order is behaviour.
    for need in plan.variables_needed:
        result.variables_created += _ensure_variable(
            session,
            project_id,
            need.name,
            need.inferred_type,
            branch_id=main_branch_id,
            index=variable_index,
        )
    col_meta = plan.col_meta
    if not col_meta:
        return result

    # Load existing events for dedup. Key on the stable scan identity (``source_name``),
    # NOT the display ``name`` — users may rename ``name`` freely, and matching on it would
    # make the next scan recreate the renamed event as a duplicate. ``source_name`` is the
    # name derived from the event-name columns at scan time; it never changes on rename.
    existing_events_query = select(Event).where(
        Event.project_id == project_id,
        Event.event_type_id == event_type_id,
    )
    if main_branch_id is not None:
        existing_events_query = existing_events_query.where(Event.branch_id == main_branch_id)
    existing_events_list = session.execute(existing_events_query).scalars().all()
    existing_by_identity: dict[str, Event] = {}
    for ev in existing_events_list:
        if ev.source_name is None:
            # Legacy / API-created rows: adopt the current name as the identity once,
            # so subsequent scans match on it instead of re-creating duplicates.
            ev.source_name = ev.name
        existing_by_identity[ev.source_name] = ev
    next_event_order = session.execute(
        select(func.max(Event.order)).where(Event.project_id == project_id)
    ).scalar_one()
    next_event_order = 0 if next_event_order is None else int(next_event_order) + 1
    logger.info(f"Loaded {len(existing_by_identity)} existing events for dedup")
    variable_contexts: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, Any]] = {}
    # ``(event_id, field_definition_id)`` pairs whose stored value this run
    # actually rewrote. Only those can invalidate an existing variable context.
    rewritten_fields: set[tuple[uuid.UUID, uuid.UUID]] = set()

    # Materialise the plan — one planned entry per breakdown row.
    for planned in plan.events:
        if result.events_created >= max_events:
            result.details.append(f"Reached max_events limit ({max_events})")
            break

        event_name = planned.name
        if planned.matched_rule_name is not None:
            result.events_grouped += 1

        # Rewrite raw path tokens to the bound variables' display names AFTER
        # the event name is built: event identity (source_name) must stay keyed
        # on raw tokens so bindings/renames don't duplicate existing events.
        # This is also why it is not in ``plan_events`` — it needs the session's
        # variable index, and nothing about the name depends on it.
        field_values = [
            (fd_id, col_name, _normalize_variable_tokens(value, variable_index))
            for fd_id, col_name, value in planned.field_values
        ]

        existing = existing_by_identity.get(event_name)
        if existing is not None:
            if existing.status == EventStatus.archived:
                # Archiving means "put it away", so an archived row is frozen:
                # a scan must not rewrite its field values or re-observe its
                # variable contexts just because the identity still arrives.
                # Counted as skipped like any other already-known identity, so
                # the run summary keeps reconciling against the plan (tripl-rsei).
                result.events_skipped += 1
                continue
            # Update field values on existing event
            rewritten_fields |= _upsert_field_values(existing, field_values)
            _record_variable_contexts(
                variable_contexts,
                event=existing,
                field_values=field_values,
                col_meta=col_meta,
                index=variable_index,
            )
            result.events_skipped += 1
            continue

        event = Event(
            id=uuid.uuid4(),
            project_id=project_id,
            event_type_id=event_type_id,
            name=event_name,
            source_name=event_name,
            description="Auto-generated from data source scan",
            order=next_event_order,
            status="in_review",
        )
        session.add(event)
        session.flush()
        next_event_order += 1

        rewritten_fields |= _upsert_field_values(event, field_values)
        _record_variable_contexts(
            variable_contexts,
            event=event,
            field_values=field_values,
            col_meta=col_meta,
            index=variable_index,
        )

        existing_by_identity[event_name] = event
        result.events_created += 1

    result.events_merged += _merge_existing_grouped_events(
        session,
        project_id=project_id,
        event_type_id=event_type_id,
        existing_by_identity=existing_by_identity,
        event_group_rules=event_group_rules,
        field_definitions=field_definitions,
        next_event_order=next_event_order,
    )
    _preserve_existing_variable_context_values(
        session,
        project_id=project_id,
        branch_id=main_branch_id,
        contexts=variable_contexts,
    )
    _delete_variable_contexts_for_event_type(
        session,
        project_id=project_id,
        branch_id=main_branch_id,
        event_type_id=event_type_id,
        contexts=variable_contexts,
        rewritten_fields=rewritten_fields,
    )
    _insert_variable_contexts(
        session,
        project_id=project_id,
        branch_id=main_branch_id,
        contexts=variable_contexts,
    )
    result.value_drifts_detected = _detect_variable_value_drifts(
        session,
        project_id=project_id,
        branch_id=main_branch_id,
        scan_config_id=scan_config_id,
        contexts=variable_contexts,
    )
    session.flush()
    if result.events_skipped:
        logger.info(f"Skipped {result.events_skipped} existing events (field values updated)")
    result.col_meta = col_meta
    result.event_type_id = event_type_id
    # Keyed by scan identity (source_name == formatted event name); metric collection looks
    # events up by the same row-derived name, so renamed events still match here.
    # Exclude archived events so we don't collect metrics/send alerts for them, but hand
    # their identities over separately — dropping them entirely is what made the collector
    # mistake an archived event for an unplanned one (tripl-w3ms).
    result.events_by_name = {
        k: v for k, v in existing_by_identity.items() if v.status != EventStatus.archived
    }
    result.archived_identities = {
        k for k, v in existing_by_identity.items() if v.status == EventStatus.archived
    }
    return result


def _upsert_field_values(
    event: Event,
    field_values: Sequence[tuple[uuid.UUID, str, str]],
) -> set[tuple[uuid.UUID, uuid.UUID]]:
    """Set field values on ``event``, deduplicating by ``field_definition_id``.

    Writes through the ``field_values`` relationship (not a bare ``session.add``)
    so that values queued during this scan are reflected in the in-memory
    collection. Without this, multiple breakdown rows collapsing to the same
    event (e.g. via scan group rules) re-queue the same
    ``(event_id, field_definition_id)`` pair and violate
    ``uq_event_field_value_event_field`` on flush.

    Returns the ``(event_id, field_definition_id)`` pairs this call actually
    changed or newly created — an authored value, or one that already reads the
    same, is NOT reported. Callers use that to scope what the run invalidated:
    see ``delete_variable_contexts_for_event_type``.
    """
    rewritten: set[tuple[uuid.UUID, uuid.UUID]] = set()
    fv_by_fd = {fv.field_definition_id: fv for fv in event.field_values}
    for fd_id, _, value in field_values:
        existing_fv = fv_by_fd.get(fd_id)
        if existing_fv is not None:
            if not existing_fv.is_authored and existing_fv.value != value:
                existing_fv.value = value
                rewritten.add((event.id, fd_id))
            continue
        new_fv = EventFieldValue(
            id=uuid.uuid4(),
            event_id=event.id,
            field_definition_id=fd_id,
            value=value,
            is_authored=False,
        )
        event.field_values.append(new_fv)
        fv_by_fd[fd_id] = new_fv
        rewritten.add((event.id, fd_id))
    return rewritten
