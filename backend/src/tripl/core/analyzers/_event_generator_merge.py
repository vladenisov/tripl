"""Event grouping rules, merge logic, and metric-row consolidation."""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.event import Event
from tripl.models.event import EventStatus as _ES
from tripl.models.event import event_status_rank as _rank
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_photo import EventPhoto
from tripl.models.field_definition import FieldDefinition
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly


@dataclass(frozen=True)
class EventGroupMatch:
    event_name: str
    field_value_overrides: dict[str, str] = field(default_factory=dict)
    matched_rule_name: str | None = None


def _format_value(raw_val: object) -> str:
    """Format a value for display, showing ints without decimal point."""
    if raw_val is None:
        return ""
    if isinstance(raw_val, float) and raw_val.is_integer():
        return str(int(raw_val))
    return str(raw_val)


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
                # DOTALL so ``.`` spans newlines: some event values carry multi-line
                # free text (e.g. a pasted notification body), and ``^...$`` anchored
                # patterns must still match those against the whole value.
                matched = (
                    re.search(
                        pattern,
                        _format_value(values_by_field.get(field_name)),
                        re.DOTALL,
                    )
                    is not None
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


def _event_values_for_group_matching(
    event: Event,
    field_name_by_id: dict[uuid.UUID, str],
) -> dict[str, str]:
    identity = event.source_name or event.name
    values = {"__event_name": identity, "event_name": identity}
    for fv in event.field_values:
        field_name = field_name_by_id.get(fv.field_definition_id)
        if field_name:
            values[field_name] = fv.value
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
        status=source.status,
        last_seen_at=source.last_seen_at,
        metric_breakdown_columns=list(source.metric_breakdown_columns or []),
    )
    session.add(target)
    session.flush()
    for fv in source.field_values:
        field_name = field_name_by_id.get(fv.field_definition_id)
        value = field_value_overrides.get(field_name or "", fv.value)
        session.add(
            EventFieldValue(
                id=uuid.uuid4(),
                event_id=target.id,
                field_definition_id=fv.field_definition_id,
                value=value,
                # A rule override replaces the hand-written value, so authored
                # provenance only survives when the value came through as-is.
                is_authored=fv.is_authored and value == fv.value,
            )
        )
    session.flush()
    return target


def _merge_event_into_group(session: Session, *, source: Event, target: Event) -> None:
    if source.last_seen_at is not None and (
        target.last_seen_at is None or source.last_seen_at > target.last_seen_at
    ):
        target.last_seen_at = source.last_seen_at
    s_status = _ES(source.status) if source.status in _ES._value2member_map_ else _ES.draft
    t_status = _ES(target.status) if target.status in _ES._value2member_map_ else _ES.draft
    if s_status != _ES.archived and t_status != _ES.archived:
        target.status = s_status if _rank(s_status) > _rank(t_status) else t_status
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
