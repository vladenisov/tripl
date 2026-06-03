"""Generate events from breakdown analysis results.

Takes breakdown analysis (per-column cardinality stats + raw GROUP BY ALL rows)
and produces deduplicated Event + EventFieldValue records.  Each breakdown row
maps to one event, preserving actual column correlations from the data.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from tripl.json_paths import (
    build_json_value,
    decode_json_path_value,
    format_json_path_value,
)
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_photo import EventPhoto
from tripl.models.field_definition import FieldDefinition
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
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
    events_grouped: int = 0
    events_merged: int = 0
    variables_created: int = 0
    columns_analyzed: int = 0
    details: list[str] = field(default_factory=list)
    col_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    events_by_name: dict[str, Event] = field(default_factory=dict)


@dataclass(frozen=True)
class EventGroupMatch:
    event_name: str
    field_value_overrides: dict[str, str] = field(default_factory=dict)
    matched_rule_name: str | None = None


def apply_event_group_rules(
    event_name: str,
    values_by_field: Mapping[str, object],
    event_group_rules: Sequence[Mapping[str, object]] | None,
) -> EventGroupMatch:
    """Return the grouped event name for the first matching scan group rule."""
    if not event_group_rules:
        return EventGroupMatch(event_name=event_name)

    for rule in event_group_rules:
        group_name = str(rule.get("name", "")).strip()
        raw_conditions = rule.get("conditions")
        if not group_name or not isinstance(raw_conditions, list):
            continue

        condition_results: list[tuple[str, str, bool]] = []
        for raw_condition in raw_conditions:
            if not isinstance(raw_condition, Mapping):
                continue
            field_name = str(raw_condition.get("field", "")).strip()
            pattern = str(raw_condition.get("pattern", "")).strip()
            if not field_name or not pattern:
                continue
            try:
                matched = (
                    re.search(pattern, _format_value(values_by_field.get(field_name))) is not None
                )
            except re.error:
                continue
            condition_results.append((field_name, pattern, matched))

        if not condition_results:
            continue

        logic = str(rule.get("condition_logic", "all")).strip().lower()
        if logic == "any":
            rule_matched = any(matched for _, _, matched in condition_results)
        else:
            rule_matched = all(matched for _, _, matched in condition_results)

        if not rule_matched:
            continue

        overrides = {
            field_name: f"/{pattern}/"
            for field_name, pattern, matched in condition_results
            if matched and field_name != "__event_name"
        }
        if len(group_name) > 500:
            group_name = group_name[:497] + "..."
        return EventGroupMatch(
            event_name=group_name,
            field_value_overrides=overrides,
            matched_rule_name=group_name,
        )

    return EventGroupMatch(event_name=event_name)


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

    result.events_merged += _merge_existing_grouped_events(
        session,
        project_id=project_id,
        event_type_id=event_type_id,
        existing_by_identity=existing_by_identity,
        event_group_rules=event_group_rules,
        field_definitions=field_definitions,
        next_event_order=next_event_order,
    )
    session.flush()
    if result.events_skipped:
        logger.info(f"Skipped {result.events_skipped} existing events (field values updated)")
    result.col_meta = col_meta
    # Keyed by scan identity (source_name == formatted event name); metric collection looks
    # events up by the same row-derived name, so renamed events still match here.
    # Exclude archived events so we don't collect metrics/send alerts for them.
    result.events_by_name = {k: v for k, v in existing_by_identity.items() if not v.archived}
    return result


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


def _merge_existing_grouped_events(
    session: Session,
    *,
    project_id: uuid.UUID,
    event_type_id: uuid.UUID,
    existing_by_identity: dict[str, Event],
    event_group_rules: Sequence[Mapping[str, object]] | None,
    field_definitions: dict[str, FieldDefinition],
    next_event_order: int,
) -> int:
    if not event_group_rules:
        return 0

    field_name_by_id = {fd.id: name for name, fd in field_definitions.items()}
    merged = 0

    for identity, source in list(existing_by_identity.items()):
        if source.project_id != project_id or source.event_type_id != event_type_id:
            continue
        values = _event_values_for_group_matching(source, field_name_by_id)
        match = apply_event_group_rules(identity, values, event_group_rules)
        if match.matched_rule_name is None:
            continue

        target = existing_by_identity.get(match.event_name)
        if target is None:
            target = _create_group_event_from_source(
                session,
                source=source,
                group_name=match.event_name,
                field_name_by_id=field_name_by_id,
                field_value_overrides=match.field_value_overrides,
                order=next_event_order,
            )
            next_event_order += 1
            existing_by_identity[match.event_name] = target

        if target.id == source.id:
            continue

        _merge_event_into_group(
            session,
            source=source,
            target=target,
        )
        for key, event in list(existing_by_identity.items()):
            if event.id == source.id:
                del existing_by_identity[key]
        merged += 1

    return merged


def merge_existing_events_for_group_rules(
    session: Session,
    *,
    project_id: uuid.UUID,
    event_type_ids: Sequence[uuid.UUID],
    event_group_rules: Sequence[Mapping[str, object]] | None,
) -> int:
    """Apply scan group rules to already-created catalog events."""
    if not event_group_rules:
        return 0

    total_merged = 0
    next_event_order = session.execute(
        select(func.max(Event.order)).where(Event.project_id == project_id)
    ).scalar_one()
    next_event_order = 0 if next_event_order is None else int(next_event_order) + 1

    for event_type_id in event_type_ids:
        field_definitions = {
            field_definition.name: field_definition
            for field_definition in session.execute(
                select(FieldDefinition).where(FieldDefinition.event_type_id == event_type_id)
            )
            .scalars()
            .all()
        }
        if not field_definitions:
            continue

        existing_events = (
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
        for event in existing_events:
            if event.source_name is None:
                event.source_name = event.name
            existing_by_identity[event.source_name] = event

        total_merged += _merge_existing_grouped_events(
            session,
            project_id=project_id,
            event_type_id=event_type_id,
            existing_by_identity=existing_by_identity,
            event_group_rules=event_group_rules,
            field_definitions=field_definitions,
            next_event_order=next_event_order,
        )
        next_event_order = session.execute(
            select(func.max(Event.order)).where(Event.project_id == project_id)
        ).scalar_one()
        next_event_order = 0 if next_event_order is None else int(next_event_order) + 1

    session.flush()
    return total_merged


def _event_values_for_group_matching(
    event: Event,
    field_name_by_id: dict[uuid.UUID, str],
) -> dict[str, str]:
    identity = event.source_name or event.name
    values = {"__event_name": identity, "event_name": identity}
    for field_value in event.field_values:
        field_name = field_name_by_id.get(field_value.field_definition_id)
        if field_name:
            values[field_name] = field_value.value
    return values


def _create_group_event_from_source(
    session: Session,
    *,
    source: Event,
    group_name: str,
    field_name_by_id: dict[uuid.UUID, str],
    field_value_overrides: dict[str, str],
    order: int,
) -> Event:
    target = Event(
        id=uuid.uuid4(),
        project_id=source.project_id,
        branch_id=source.branch_id,
        event_type_id=source.event_type_id,
        name=group_name,
        source_name=group_name,
        description="Auto-generated event group from data source scan",
        order=order,
        implemented=source.implemented,
        reviewed=False,
        archived=False,
        last_seen_at=source.last_seen_at,
        metric_breakdown_columns=list(source.metric_breakdown_columns or []),
    )
    session.add(target)
    session.flush()
    for field_value in source.field_values:
        field_name = field_name_by_id.get(field_value.field_definition_id)
        value = field_value_overrides.get(field_name or "", field_value.value)
        session.add(
            EventFieldValue(
                id=uuid.uuid4(),
                event_id=target.id,
                field_definition_id=field_value.field_definition_id,
                value=value,
            )
        )
    session.flush()
    return target


def _merge_event_into_group(session: Session, *, source: Event, target: Event) -> None:
    if source.last_seen_at is not None and (
        target.last_seen_at is None or source.last_seen_at > target.last_seen_at
    ):
        target.last_seen_at = source.last_seen_at
    target.implemented = target.implemented or source.implemented
    target.reviewed = target.reviewed and source.reviewed
    target.archived = False
    target.metric_breakdown_columns = sorted(
        set(target.metric_breakdown_columns or []) | set(source.metric_breakdown_columns or [])
    )

    _move_event_tags(session, source=source, target=target)
    _move_event_meta_values(session, source=source, target=target)
    session.execute(
        update(EventPhoto).where(EventPhoto.event_id == source.id).values(event_id=target.id)
    )
    _merge_event_metric_rows(session, source_ids=[source.id], target_id=target.id)
    _merge_event_metric_breakdown_rows(session, source_ids=[source.id], target_id=target.id)
    _delete_event_anomalies(session, event_ids=[source.id, target.id])
    session.execute(
        update(AlertDeliveryItem)
        .where(AlertDeliveryItem.event_id == source.id)
        .values(event_id=target.id, scope_ref=str(target.id), scope_name=target.name)
    )
    session.delete(source)
    session.flush()


def _move_event_tags(session: Session, *, source: Event, target: Event) -> None:
    target_names = {tag.name for tag in target.tags}
    for tag in list(source.tags):
        if tag.name in target_names:
            session.delete(tag)
            continue
        source.tags.remove(tag)
        target.tags.append(tag)
        tag.event_id = target.id
        target_names.add(tag.name)


def _move_event_meta_values(session: Session, *, source: Event, target: Event) -> None:
    target_meta_ids = {value.meta_field_definition_id for value in target.meta_values}
    for meta_value in list(source.meta_values):
        if meta_value.meta_field_definition_id in target_meta_ids:
            session.delete(meta_value)
            continue
        source.meta_values.remove(meta_value)
        target.meta_values.append(meta_value)
        meta_value.event_id = target.id
        target_meta_ids.add(meta_value.meta_field_definition_id)


def _merge_event_metric_rows(
    session: Session,
    *,
    source_ids: list[uuid.UUID],
    target_id: uuid.UUID,
) -> None:
    event_ids = [target_id, *source_ids]
    rows = session.execute(
        select(
            EventMetric.scan_config_id,
            EventMetric.bucket,
            func.sum(EventMetric.count),
        )
        .where(EventMetric.event_id.in_(event_ids))
        .group_by(EventMetric.scan_config_id, EventMetric.bucket)
    ).all()
    if not rows:
        return

    session.execute(delete(EventMetric).where(EventMetric.event_id.in_(event_ids)))
    for scan_config_id, bucket, count in rows:
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=scan_config_id,
                event_id=target_id,
                event_type_id=None,
                bucket=bucket,
                count=int(count or 0),
            )
        )


def _merge_event_metric_breakdown_rows(
    session: Session,
    *,
    source_ids: list[uuid.UUID],
    target_id: uuid.UUID,
) -> None:
    event_ids = [target_id, *source_ids]
    rows = session.execute(
        select(
            EventMetricBreakdown.scan_config_id,
            EventMetricBreakdown.bucket,
            EventMetricBreakdown.breakdown_column,
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            func.sum(EventMetricBreakdown.count),
        )
        .where(EventMetricBreakdown.event_id.in_(event_ids))
        .group_by(
            EventMetricBreakdown.scan_config_id,
            EventMetricBreakdown.bucket,
            EventMetricBreakdown.breakdown_column,
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
        )
    ).all()
    if not rows:
        return

    session.execute(
        delete(EventMetricBreakdown).where(EventMetricBreakdown.event_id.in_(event_ids))
    )
    for scan_config_id, bucket, breakdown_column, breakdown_value, is_other, count in rows:
        session.add(
            EventMetricBreakdown(
                id=uuid.uuid4(),
                scan_config_id=scan_config_id,
                event_id=target_id,
                event_type_id=None,
                bucket=bucket,
                breakdown_column=breakdown_column,
                breakdown_value=breakdown_value,
                is_other=bool(is_other),
                count=int(count or 0),
            )
        )


def _delete_event_anomalies(session: Session, *, event_ids: list[uuid.UUID]) -> None:
    scope_refs = [str(event_id) for event_id in event_ids]
    session.execute(
        delete(MetricAnomaly).where(
            MetricAnomaly.scope_type == "event",
            MetricAnomaly.scope_ref.in_(scope_refs),
        )
    )
    session.execute(
        delete(MetricAnomaly).where(
            MetricAnomaly.scope_type == "event",
            MetricAnomaly.event_id.in_(event_ids),
        )
    )
    session.execute(
        delete(MetricBreakdownAnomaly).where(
            MetricBreakdownAnomaly.scope_type == "event",
            MetricBreakdownAnomaly.scope_ref.in_(scope_refs),
        )
    )
    session.execute(
        delete(MetricBreakdownAnomaly).where(
            MetricBreakdownAnomaly.scope_type == "event",
            MetricBreakdownAnomaly.event_id.in_(event_ids),
        )
    )


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
