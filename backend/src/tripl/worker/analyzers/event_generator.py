"""Generate events from breakdown analysis results.

Takes breakdown analysis (per-column cardinality stats + raw GROUP BY ALL rows)
and produces deduplicated Event + EventFieldValue records.  Each breakdown row
maps to one event, preserving actual column correlations from the data.
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tripl.json_paths import (
    build_json_value,
    decode_json_path_value,
    format_json_path_value,
)
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.field_definition import FieldDefinition
from tripl.models.variable import Variable
from tripl.worker.analyzers.cardinality import BreakdownAnalysis
from tripl.worker.analyzers.variable_detector import (
    DetectedPattern,
    detect_variables,
)

logger = logging.getLogger(__name__)


def _format_value(raw_val: object) -> str:
    """Format a value for display, showing ints without decimal point."""
    if raw_val is None:
        return ""
    if isinstance(raw_val, float) and raw_val.is_integer():
        return str(int(raw_val))
    return str(raw_val)


@dataclass
class GenerationResult:
    events_created: int = 0
    events_skipped: int = 0
    variables_created: int = 0
    columns_analyzed: int = 0
    details: list[str] = field(default_factory=list)
    col_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    events_by_name: dict[str, Event] = field(default_factory=dict)


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
    max_events: int = 10000,
) -> GenerationResult:
    """Generate events from breakdown analysis.

    Each row from the GROUP BY ALL breakdown becomes one event.
    Low-cardinality columns use actual values from the row,
    high-cardinality columns use detected templates with ${var} placeholders,
    JSON columns use their actual path combo from the row.
    """
    result = GenerationResult()
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
                    session, project_id, var_name, "string"
                )
            meta["json_passthrough_paths"] = passthrough_paths
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
                for var in pattern.variables:
                    result.variables_created += _ensure_variable(
                        session, project_id, var.name, var.inferred_type
                    )
                meta["template"] = pattern.template

        col_meta[col_name] = meta

    if not col_meta:
        result.details.append("No columns matched field definitions")
        return result

    # Load existing events for dedup. Key on the stable scan identity (``source_name``),
    # NOT the display ``name`` — users may rename ``name`` freely, and matching on it would
    # make the next scan recreate the renamed event as a duplicate. ``source_name`` is the
    # name derived from the event-name columns at scan time; it never changes on rename.
    existing_events_list = (
        session.execute(
            select(Event).where(
                Event.project_id == project_id,
                Event.event_type_id == event_type_id,
            )
        )
        .scalars()
        .all()
    )
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

    # Iterate breakdown rows — each row is one event
    for row in analysis.rows:
        if result.events_created >= max_events:
            result.details.append(f"Reached max_events limit ({max_events})")
            break

        field_values: list[tuple[uuid.UUID, str, str]] = []

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

        existing = existing_by_identity.get(event_name)
        if existing is not None:
            # Update field values on existing event
            fv_by_fd = {fv.field_definition_id: fv for fv in existing.field_values}
            for fd_id, _, value in field_values:
                if fd_id in fv_by_fd:
                    fv_by_fd[fd_id].value = value
                else:
                    session.add(
                        EventFieldValue(
                            id=uuid.uuid4(),
                            event_id=existing.id,
                            field_definition_id=fd_id,
                            value=value,
                        )
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
            implemented=True,
            reviewed=False,
        )
        session.add(event)
        session.flush()
        next_event_order += 1

        for fd_id, _, value in field_values:
            fv = EventFieldValue(
                id=uuid.uuid4(),
                event_id=event.id,
                field_definition_id=fd_id,
                value=value,
            )
            session.add(fv)

        existing_by_identity[event_name] = event
        result.events_created += 1

    session.flush()
    if result.events_skipped:
        logger.info(f"Skipped {result.events_skipped} existing events (field values updated)")
    result.col_meta = col_meta
    # Keyed by scan identity (source_name == formatted event name); metric collection looks
    # events up by the same row-derived name, so renamed events still match here.
    # Exclude archived events so we don't collect metrics/send alerts for them.
    result.events_by_name = {k: v for k, v in existing_by_identity.items() if not v.archived}
    return result


_FMT_PATTERN = re.compile(r"\{([^}]+)\}")


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


def _ensure_variable(
    session: Session,
    project_id: uuid.UUID,
    name: str,
    inferred_type: str,
) -> int:
    """Create a Variable if it doesn't exist. Returns 1 if created, 0 if already exists.

    Looks up by source_name (the original scan-detected name) so that
    user renames of the display ``name`` don't cause duplicates.
    """
    existing = session.execute(
        select(Variable).where(
            Variable.project_id == project_id,
            Variable.source_name == name,
        )
    ).scalar_one_or_none()

    if existing is not None:
        return 0

    # Also check by name (covers manually created variables)
    existing_by_name = session.execute(
        select(Variable).where(
            Variable.project_id == project_id,
            Variable.name == name,
        )
    ).scalar_one_or_none()

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
    session.add(var)
    session.flush()
    return 1
