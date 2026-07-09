"""Generate events from breakdown analysis results.

Takes breakdown analysis (per-column cardinality stats + raw GROUP BY ALL rows)
and produces deduplicated Event + EventFieldValue records.  Each breakdown row
maps to one event, preserving actual column correlations from the data.

Implementation is split across two private sibling modules:

* ``_event_generator_variables``  — variable detection, creation, context ops
* ``_event_generator_merge``      — grouping rules, merge/consolidation logic
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Mapping, Sequence
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
from tripl.core.analyzers._event_generator_variables import (
    sample_variable_values as _sample_variable_values,
)
from tripl.core.analyzers.cardinality import BreakdownAnalysis
from tripl.core.analyzers.variable_detector import (
    DetectedPattern,
    detect_variables,
)
from tripl.json_paths import (
    build_json_value,
    decode_json_path_value,
    format_json_path_value,
)
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.field_definition import FieldDefinition
from tripl.models.variable_value import VariableValueKind

logger = logging.getLogger(__name__)

VARIABLE_VALUE_SAMPLE_LIMIT = 20

# Re-export public names that callers import directly from this module.
__all__ = [
    "EventGroupMatch",
    "GenerationResult",
    "VariableObservation",
    "_ensure_variable",
    "_resolve_main_branch_id",
    "apply_event_group_rules",
    "generate_events",
    "merge_existing_events_for_group_rules",
]

_FMT_PATTERN = re.compile(r"\{([^}]+)\}")


@dataclass
class GenerationResult:
    event_type_id: uuid.UUID | None = None
    events_created: int = 0
    events_skipped: int = 0
    events_grouped: int = 0
    events_merged: int = 0
    variables_created: int = 0
    columns_analyzed: int = 0
    details: list[str] = field(default_factory=list)
    col_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    events_by_name: dict[str, Event] = field(default_factory=dict)
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
    max_events: int = 10000,
) -> GenerationResult:
    """Generate events from breakdown analysis.

    Each row from the GROUP BY ALL breakdown becomes one event.
    Low-cardinality columns use actual values from the row,
    high-cardinality columns use detected templates with ${var} placeholders,
    JSON columns use their actual path combo from the row.
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
    # Columns referenced by the event-name format are the event's identity, so they must be
    # enumerated (one event per distinct value) even when high-cardinality — otherwise they
    # collapse into a single ${col} template and every row dedups to one event.
    name_columns: set[str] = (
        set(_FMT_PATTERN.findall(event_name_format)) if event_name_format else set()
    )
    cardinality_results = analysis.results
    reg_index = {name: i for i, name in enumerate(analysis.reg_names)}
    json_index = {name: i for i, name in enumerate(analysis.json_names)}
    n_reg = len(analysis.reg_names)
    json_value_index = {
        name: n_reg + len(analysis.json_names) + idx
        for idx, name in enumerate(analysis.json_value_names)
    }

    # Pre-compute per-column metadata
    col_meta: dict[str, dict[str, Any]] = {}

    for col_name, card_result in cardinality_results.items():
        if col_name == event_type_column:
            continue
        if col_name == time_column:
            continue

        fd = field_definitions.get(col_name)
        if fd is None:
            result.details.append(f"Skipped column {col_name!r}: no matching field definition")
            continue

        result.columns_analyzed += 1
        meta: dict[str, Any] = {"fd_id": fd.id, "col_name": col_name}

        if card_result.json_path_combos is not None:
            meta["is_json"] = True
            all_paths: set[str] = set()
            passthrough_paths: list[str] = []
            variable_observations: list[VariableObservation] = []
            for combo in card_result.json_path_combos:
                for path in combo:
                    all_paths.add(path)
            for path in sorted(all_paths):
                full_path = f"{col_name}.{path}"
                if full_path in json_value_index:
                    passthrough_paths.append(full_path)
                    continue
                var_name = full_path
                result.variables_created += _ensure_variable(
                    session,
                    project_id,
                    var_name,
                    "string",
                    branch_id=main_branch_id,
                    index=variable_index,
                )
                variable_observations.append(
                    VariableObservation(
                        name=var_name,
                        source_column=full_path,
                        value_kind=VariableValueKind.high.value,
                        observed_count=0,
                        values=[],
                    )
                )
            meta["json_passthrough_paths"] = passthrough_paths
            meta["variable_observations"] = variable_observations
            logger.info(
                f"  {col_name}: JSON, {len(card_result.json_path_combos)} path combos, "
                f"{len(all_paths) - len(passthrough_paths)} variables"
            )
        else:
            meta["is_json"] = False
            # Force enumeration for event-name columns regardless of cardinality.
            force_enumerate = col_name in name_columns
            meta["is_low"] = card_result.is_low or force_enumerate
            if not card_result.is_low and not force_enumerate:
                pattern = detect_variables(
                    col_name, card_result.sample_values, cardinality_threshold
                )
                if pattern is None:
                    pattern = DetectedPattern(
                        template=f"${{{col_name}}}",
                        variables=[],
                        coverage_pct=100.0,
                    )
                regular_variable_observations: list[VariableObservation] = []
                for var in pattern.variables:
                    result.variables_created += _ensure_variable(
                        session,
                        project_id,
                        var.name,
                        var.inferred_type,
                        branch_id=main_branch_id,
                        index=variable_index,
                    )
                    observed_count = var.distinct_count or len(var.values)
                    value_kind = (
                        VariableValueKind.low.value
                        if observed_count > 0 and observed_count <= cardinality_threshold
                        else VariableValueKind.high.value
                    )
                    regular_variable_observations.append(
                        VariableObservation(
                            name=var.name,
                            source_column=col_name,
                            value_kind=value_kind,
                            observed_count=observed_count,
                            values=_sample_variable_values(var.values, value_kind),
                        )
                    )
                meta["template"] = pattern.template
                meta["variable_observations"] = regular_variable_observations

        col_meta[col_name] = meta

    if not col_meta:
        result.details.append("No columns matched field definitions")
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

    # Iterate breakdown rows — each row is one event
    for row in analysis.rows:
        if result.events_created >= max_events:
            result.details.append(f"Reached max_events limit ({max_events})")
            break

        field_values: list[tuple[uuid.UUID, str, str]] = []
        raw_values_by_field = _raw_values_from_row(
            row,
            analysis=analysis,
            event_type_column=event_type_column,
            time_column=time_column,
        )

        for col_name, meta in col_meta.items():
            if meta["is_json"]:
                j = json_index.get(col_name)
                if j is None:
                    continue
                paths = row[n_reg + j]
                if paths:
                    if isinstance(paths, (list, tuple)):
                        sorted_paths = sorted(str(p) for p in paths)
                    else:
                        sorted_paths = [str(paths)]
                    preserved_values = {
                        full_path: decode_json_path_value(row[json_value_index[full_path]])
                        for full_path in meta.get("json_passthrough_paths", [])
                        if full_path in json_value_index and full_path.startswith(f"{col_name}.")
                    }
                    value = build_json_value(
                        col_name,
                        sorted_paths,
                        preserved_values=preserved_values,
                    )
                else:
                    value = "{}"
            elif meta["is_low"]:
                i = reg_index.get(col_name)
                if i is None:
                    continue
                raw_val = row[i]
                value = _format_value(raw_val)
            else:
                value = meta["template"]

            field_values.append((meta["fd_id"], col_name, value))

        # Build event name
        if event_name_format:
            fmt_kwargs: dict[str, str] = {}
            for _, col_name, value in field_values:
                fmt_kwargs[col_name] = value
            for col_name, meta in col_meta.items():
                if not meta["is_json"]:
                    continue
                j = json_index.get(col_name)
                if j is None:
                    continue
                paths = row[n_reg + j]
                if not paths:
                    continue
                if isinstance(paths, (list, tuple)):
                    sorted_paths = sorted(str(path) for path in paths)
                else:
                    sorted_paths = [str(paths)]
                for path in sorted_paths:
                    full_path = f"{col_name}.{path}"
                    if full_path in json_value_index:
                        fmt_kwargs[full_path] = format_json_path_value(
                            row[json_value_index[full_path]]
                        )
                    else:
                        fmt_kwargs[full_path] = f"${{{full_path}}}"
            event_name = _apply_name_format(event_name_format, fmt_kwargs)
        else:
            parts = []
            for _, col_name, value in field_values:
                display = value if len(value) <= 80 else value[:77] + "..."
                parts.append(f"{col_name}={display}")
            event_name = " | ".join(parts)

        # Truncate event_name to respect VARCHAR(500) database limit
        if len(event_name) > 500:
            event_name = event_name[:497] + "..."

        raw_values_by_field["__event_name"] = event_name
        raw_values_by_field.setdefault("event_name", event_name)
        group_match = apply_event_group_rules(
            event_name,
            raw_values_by_field,
            event_group_rules,
        )
        if group_match.matched_rule_name is not None:
            result.events_grouped += 1
            event_name = group_match.event_name
            if group_match.field_value_overrides:
                field_values = [
                    (fd_id, col_name, group_match.field_value_overrides.get(col_name, value))
                    for fd_id, col_name, value in field_values
                ]

        # Rewrite raw path tokens to the bound variables' display names AFTER
        # the event name is built: event identity (source_name) must stay keyed
        # on raw tokens so bindings/renames don't duplicate existing events.
        field_values = [
            (fd_id, col_name, _normalize_variable_tokens(value, variable_index))
            for fd_id, col_name, value in field_values
        ]

        existing = existing_by_identity.get(event_name)
        if existing is not None:
            # Update field values on existing event
            _upsert_field_values(existing, field_values)
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

        _upsert_field_values(event, field_values)
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
    )
    _insert_variable_contexts(
        session,
        project_id=project_id,
        branch_id=main_branch_id,
        contexts=variable_contexts,
    )
    session.flush()
    if result.events_skipped:
        logger.info(f"Skipped {result.events_skipped} existing events (field values updated)")
    result.col_meta = col_meta
    result.event_type_id = event_type_id
    # Keyed by scan identity (source_name == formatted event name); metric collection looks
    # events up by the same row-derived name, so renamed events still match here.
    # Exclude archived events so we don't collect metrics/send alerts for them.
    result.events_by_name = {
        k: v for k, v in existing_by_identity.items() if v.status != "archived"
    }
    return result


def _format_value(raw_val: object) -> str:
    """Format a value for display, showing ints without decimal point."""
    if raw_val is None:
        return ""
    if isinstance(raw_val, float) and raw_val.is_integer():
        return str(int(raw_val))
    return str(raw_val)


def _upsert_field_values(
    event: Event,
    field_values: Sequence[tuple[uuid.UUID, str, str]],
) -> None:
    """Set field values on ``event``, deduplicating by ``field_definition_id``.

    Writes through the ``field_values`` relationship (not a bare ``session.add``)
    so that values queued during this scan are reflected in the in-memory
    collection. Without this, multiple breakdown rows collapsing to the same
    event (e.g. via scan group rules) re-queue the same
    ``(event_id, field_definition_id)`` pair and violate
    ``uq_event_field_value_event_field`` on flush.
    """
    fv_by_fd = {fv.field_definition_id: fv for fv in event.field_values}
    for fd_id, _, value in field_values:
        existing_fv = fv_by_fd.get(fd_id)
        if existing_fv is not None:
            if not existing_fv.is_authored:
                existing_fv.value = value
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


def _raw_values_from_row(
    row: tuple[object, ...],
    *,
    analysis: BreakdownAnalysis,
    event_type_column: str | None,
    time_column: str | None,
) -> dict[str, str]:
    values: dict[str, str] = {}
    n_reg = len(analysis.reg_names)
    json_value_index = {
        name: n_reg + len(analysis.json_names) + idx
        for idx, name in enumerate(analysis.json_value_names)
    }

    for idx, col_name in enumerate(analysis.reg_names):
        if col_name == time_column:
            continue
        values[col_name] = _format_value(row[idx])

    for idx, col_name in enumerate(analysis.json_names):
        if col_name in (event_type_column, time_column):
            continue
        paths = row[n_reg + idx]
        if isinstance(paths, (list, tuple)):
            values[col_name] = ",".join(sorted(str(path) for path in paths))
        elif paths:
            values[col_name] = str(paths)
        for full_path, value_idx in json_value_index.items():
            if full_path.startswith(f"{col_name}."):
                values[full_path] = format_json_path_value(row[value_idx])

    return values


def _apply_name_format(fmt: str, kwargs: dict[str, str]) -> str:
    """Replace {key} placeholders, supporting keys with dots like {event.category}."""
    missing: list[str] = []

    def _replacer(m: re.Match[str]) -> str:
        key = m.group(1)
        if key in kwargs:
            return kwargs[key]
        missing.append(key)
        return m.group(0)

    result = _FMT_PATTERN.sub(_replacer, fmt)
    if missing:
        available = ", ".join(sorted(kwargs))
        msg = (
            f"event_name_format references unknown keys: {', '.join(missing)}. "
            f"Available keys: {available}"
        )
        raise ValueError(msg)
    return result
