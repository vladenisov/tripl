"""Document building helpers for the search index.

Converts project entities (event types, events, fields, variables, relations,
tags, metrics, fact tables) into ``BuiltDocument`` instances ready to be
stored as ``SearchDocument`` rows.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_meta_value import EventMetaValue
from tripl.models.event_tag import EventTag
from tripl.models.event_type import EventType
from tripl.models.event_type_relation import EventTypeRelation
from tripl.models.fact_table import FactTable
from tripl.models.field_definition import FieldDefinition
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.models.metric_definition import MetricDefinition
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.schemas.search import SearchEntityType


def _clean(value: object | None) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _join(parts: Sequence[object | None]) -> str:
    values = [_clean(part) for part in parts]
    return " ".join(value for value in values if value)


def _is_sensitive(sensitivity: str | None) -> bool:
    return (sensitivity or "none") != "none"


@dataclass(frozen=True)
class BuiltDocument:
    entity_type: SearchEntityType
    entity_id: uuid.UUID
    parent_event_id: uuid.UUID | None
    title: str
    subtitle: str
    body: str
    keywords: str
    route_path: str
    description: str = ""
    archived: bool = False

    @property
    def content_hash(self) -> str:
        content = "\n".join(
            [
                self.entity_type,
                str(self.entity_id),
                self.title,
                self.subtitle,
                self.description,
                self.body,
                self.keywords,
                self.route_path,
                str(self.archived),
            ]
        )
        return hashlib.sha256(content.encode("utf-8")).hexdigest()


async def build_documents(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str,
) -> list[BuiltDocument]:
    event_types = list(
        (
            await session.execute(
                select(EventType)
                .where(EventType.project_id == project_id, EventType.branch_id == branch_id)
                .options(selectinload(EventType.field_definitions))
            )
        )
        .scalars()
        .all()
    )
    event_types_by_id = {event_type.id: event_type for event_type in event_types}

    meta_fields = list(
        (
            await session.execute(
                select(MetaFieldDefinition).where(
                    MetaFieldDefinition.project_id == project_id,
                    MetaFieldDefinition.branch_id == branch_id,
                )
            )
        )
        .scalars()
        .all()
    )

    events = list(
        (
            await session.execute(
                select(Event)
                .where(Event.project_id == project_id, Event.branch_id == branch_id)
                .options(
                    selectinload(Event.event_type),
                    selectinload(Event.field_values).selectinload(EventFieldValue.field_definition),
                    selectinload(Event.meta_values).selectinload(
                        EventMetaValue.meta_field_definition
                    ),
                    selectinload(Event.tags),
                )
            )
        )
        .scalars()
        .all()
    )

    variables = list(
        (
            await session.execute(
                select(Variable).where(
                    Variable.project_id == project_id,
                    Variable.branch_id == branch_id,
                )
            )
        )
        .scalars()
        .all()
    )
    variable_values = list(
        (
            await session.execute(
                select(VariableValue)
                .where(
                    VariableValue.project_id == project_id,
                    VariableValue.branch_id == branch_id,
                )
                .options(
                    selectinload(VariableValue.variable),
                    selectinload(VariableValue.event),
                    selectinload(VariableValue.field_definition),
                )
            )
        )
        .scalars()
        .all()
    )
    contexts_by_event_field: dict[tuple[uuid.UUID, uuid.UUID], list[VariableValue]] = {}
    contexts_by_variable: dict[uuid.UUID, list[VariableValue]] = {}
    for context in variable_values:
        contexts_by_event_field.setdefault(
            (context.event_id, context.field_definition_id),
            [],
        ).append(context)
        contexts_by_variable.setdefault(context.variable_id, []).append(context)
    relations = list(
        (
            await session.execute(
                select(EventTypeRelation)
                .where(
                    EventTypeRelation.project_id == project_id,
                    EventTypeRelation.branch_id == branch_id,
                )
                .options(
                    selectinload(EventTypeRelation.source_event_type),
                    selectinload(EventTypeRelation.target_event_type),
                    selectinload(EventTypeRelation.source_field),
                    selectinload(EventTypeRelation.target_field),
                )
            )
        )
        .scalars()
        .all()
    )

    # Metrics and fact tables are GLOBAL, project-scoped entities (not
    # plan-branched), so they are queried by project_id only; the same
    # documents are duplicated into each branch's index — consistent with the
    # per-branch index design. Ordered by name for deterministic output.
    metrics = list(
        (
            await session.execute(
                select(MetricDefinition)
                .where(MetricDefinition.project_id == project_id)
                .order_by(MetricDefinition.name)
            )
        )
        .scalars()
        .all()
    )
    fact_tables = list(
        (
            await session.execute(
                select(FactTable).where(FactTable.project_id == project_id).order_by(FactTable.name)
            )
        )
        .scalars()
        .all()
    )

    documents: list[BuiltDocument] = []
    for event_type in event_types:
        documents.append(_event_type_document(event_type, slug))
        for field in sorted(event_type.field_definitions, key=lambda item: item.order):
            documents.append(_field_document(field, event_type, slug))

    for meta_field in meta_fields:
        documents.append(_meta_field_document(meta_field, slug))

    for event in events:
        event_type = event_types_by_id.get(event.event_type_id, event.event_type)
        documents.append(_event_document(event, event_type, slug, contexts_by_event_field))
        for tag in event.tags:
            documents.append(_tag_document(tag, event, event_type, slug))

    for variable in variables:
        documents.append(
            _variable_document(variable, slug, contexts_by_variable.get(variable.id, []))
        )

    for relation in relations:
        documents.append(_relation_document(relation, slug))

    for metric in metrics:
        documents.append(_metric_document(metric, slug))

    for fact_table in fact_tables:
        documents.append(_fact_table_document(fact_table, slug))

    return documents


def _event_type_document(event_type: EventType, slug: str) -> BuiltDocument:
    fields = sorted(event_type.field_definitions, key=lambda field: field.order)
    field_text = _join(
        [
            _join(
                [
                    field.name,
                    field.display_name,
                    field.field_type,
                    field.description,
                    " ".join(field.enum_options or []),
                ]
            )
            for field in fields
        ]
    )
    return BuiltDocument(
        entity_type="event_type",
        entity_id=event_type.id,
        parent_event_id=None,
        title=event_type.display_name,
        subtitle=event_type.name,
        description=_clean(event_type.description),
        body=_join([event_type.description, field_text]),
        keywords=_join([event_type.name, event_type.display_name]),
        route_path=f"/p/{slug}/events/{event_type.name}",
    )


def _field_document(field: FieldDefinition, event_type: EventType, slug: str) -> BuiltDocument:
    return BuiltDocument(
        entity_type="field",
        entity_id=field.id,
        parent_event_id=None,
        title=field.display_name or field.name,
        subtitle=f"{event_type.display_name} field",
        description=_clean(field.description),
        body=_join(
            [
                field.name,
                field.description,
                field.field_type,
                "required" if field.is_required else "",
                " ".join(field.enum_options or []),
            ]
        ),
        keywords=_join([field.name, field.display_name, event_type.name, event_type.display_name]),
        route_path=f"/p/{slug}/settings/event-types",
    )


def _meta_field_document(meta_field: MetaFieldDefinition, slug: str) -> BuiltDocument:
    return BuiltDocument(
        entity_type="meta_field",
        entity_id=meta_field.id,
        parent_event_id=None,
        title=meta_field.display_name or meta_field.name,
        subtitle="Meta field",
        body=_join(
            [
                meta_field.name,
                meta_field.field_type,
                "required" if meta_field.is_required else "",
                " ".join(meta_field.enum_options or []),
                meta_field.default_value if not _is_sensitive(meta_field.sensitivity) else "",
            ]
        ),
        keywords=_join([meta_field.name, meta_field.display_name]),
        route_path=f"/p/{slug}/settings/meta-fields",
    )


def _event_document(
    event: Event,
    event_type: EventType | None,
    slug: str,
    contexts_by_event_field: Mapping[tuple[uuid.UUID, uuid.UUID], list[VariableValue]],
) -> BuiltDocument:
    field_names: list[str] = []
    safe_values: list[str] = []
    variable_context_text: list[str] = []
    for field_value in event.field_values:
        field = field_value.field_definition
        field_names.extend([field.name, field.display_name, field.description])
        if not _is_sensitive(field.sensitivity):
            safe_values.append(field_value.value)
            variable_context_text.append(
                _variable_context_text(
                    contexts_by_event_field.get((event.id, field_value.field_definition_id), []),
                    include_event_names=False,
                )
            )

    meta_names: list[str] = []
    safe_meta_values: list[str] = []
    for meta_value in event.meta_values:
        meta_field = meta_value.meta_field_definition
        meta_names.extend([meta_field.name, meta_field.display_name])
        if not _is_sensitive(meta_field.sensitivity):
            safe_meta_values.append(meta_value.value)

    tag_names = [tag.name for tag in event.tags]
    event_type_names = []
    if event_type is not None:
        event_type_names = [event_type.name, event_type.display_name, event_type.description]

    return BuiltDocument(
        entity_type="event",
        entity_id=event.id,
        parent_event_id=event.id,
        title=event.name,
        subtitle=event_type.display_name if event_type is not None else "",
        description=_clean(event.description),
        body=_join(
            [
                event.description,
                " ".join(event_type_names),
                " ".join(field_names),
                " ".join(safe_values),
                " ".join(variable_context_text),
                " ".join(meta_names),
                " ".join(safe_meta_values),
                " ".join(tag_names),
            ]
        ),
        keywords=_join(
            [
                event.name,
                event.source_name,
                " ".join(event_type_names),
                " ".join(tag_names),
                " ".join(event.metric_breakdown_columns),
                " ".join(safe_values),
                " ".join(variable_context_text),
            ]
        ),
        route_path=f"/p/{slug}/monitoring/event/{event.id}",
        archived=(event.status == "archived"),
    )


def _tag_document(
    tag: EventTag,
    event: Event,
    event_type: EventType | None,
    slug: str,
) -> BuiltDocument:
    return BuiltDocument(
        entity_type="tag",
        entity_id=tag.id,
        parent_event_id=event.id,
        title=f"#{tag.name}",
        subtitle=event.name,
        description=_clean(event.description),
        body=_join(
            [
                tag.name,
                event.name,
                event.description,
                event_type.display_name if event_type is not None else "",
            ]
        ),
        keywords=tag.name,
        route_path=f"/p/{slug}/monitoring/event/{event.id}",
        archived=(event.status == "archived"),
    )


def _variable_document(
    variable: Variable,
    slug: str,
    contexts: list[VariableValue],
) -> BuiltDocument:
    context_text = _variable_context_text(contexts, include_event_names=True)
    value_keywords = _variable_value_keywords(contexts)
    return BuiltDocument(
        entity_type="variable",
        entity_id=variable.id,
        parent_event_id=None,
        title=f"${{{variable.name}}}",
        subtitle=variable.variable_type,
        description=_clean(variable.description),
        body=_join([variable.name, variable.source_name, variable.description, context_text]),
        keywords=_join([variable.name, variable.source_name, context_text, value_keywords]),
        route_path=f"/p/{slug}/settings/variables",
    )


def _variable_value_keywords(contexts: list[VariableValue]) -> str:
    values: list[str] = []
    seen: set[str] = set()
    for context in contexts:
        field = context.field_definition
        if _is_sensitive(field.sensitivity):
            continue
        for value in context.values or []:
            if value in seen:
                continue
            seen.add(value)
            values.append(value)
    return " ".join(values)


def _variable_context_text(
    contexts: list[VariableValue],
    *,
    include_event_names: bool,
) -> str:
    parts: list[str] = []
    for context in contexts:
        field = context.field_definition
        safe_values = "" if _is_sensitive(field.sensitivity) else " ".join(context.values or [])
        parts.append(
            _join(
                [
                    context.variable.name,
                    context.variable.source_name,
                    context.source_column,
                    context.value_kind,
                    str(context.observed_count),
                    context.event.name if include_event_names else "",
                    field.name,
                    field.display_name,
                    safe_values,
                ]
            )
        )
    return _join(parts)


def _relation_document(relation: EventTypeRelation, slug: str) -> BuiltDocument:
    source_type = relation.source_event_type
    target_type = relation.target_event_type
    source_field = relation.source_field
    target_field = relation.target_field
    return BuiltDocument(
        entity_type="relation",
        entity_id=relation.id,
        parent_event_id=None,
        title=f"{source_type.display_name} -> {target_type.display_name}",
        subtitle=relation.relation_type,
        description=_clean(relation.description),
        body=_join(
            [
                relation.description,
                source_type.name,
                source_type.display_name,
                target_type.name,
                target_type.display_name,
                source_field.name,
                source_field.display_name,
                target_field.name,
                target_field.display_name,
            ]
        ),
        keywords=_join([relation.relation_type, source_field.name, target_field.name]),
        route_path=f"/p/{slug}/settings/relations",
    )


def _metric_document(metric: MetricDefinition, slug: str) -> BuiltDocument:
    return BuiltDocument(
        entity_type="metric",
        entity_id=metric.id,
        parent_event_id=None,
        title=metric.display_name,
        subtitle=metric.name,
        description=_clean(metric.description),
        body=_join(
            [
                metric.description,
                metric.kind,
                metric.aggregation,
                metric.composition,
                metric.unit,
                " ".join(metric.breakdown_columns or []),
                metric.app_version_column,
                metric.platform_column,
            ]
        ),
        keywords=_join([metric.name, metric.display_name, metric.unit, metric.kind]),
        route_path=f"/p/{slug}/monitoring/metric/{metric.id}",
        archived=(metric.status == "archived"),
    )


def _fact_table_document(fact_table: FactTable, slug: str) -> BuiltDocument:
    column_names = [
        column["name"]
        for column in (fact_table.columns or [])
        if isinstance(column, dict) and "name" in column
    ]
    filter_names = [
        row_filter["name"]
        for row_filter in (fact_table.row_filters or [])
        if isinstance(row_filter, dict) and "name" in row_filter
    ]
    return BuiltDocument(
        entity_type="fact_table",
        entity_id=fact_table.id,
        parent_event_id=None,
        title=fact_table.display_name,
        subtitle=fact_table.name,
        description=_clean(fact_table.description),
        body=_join(
            [
                fact_table.description,
                fact_table.timestamp_column,
                " ".join(column_names),
                " ".join(fact_table.identifier_columns or []),
                " ".join(filter_names),
            ]
        ),
        keywords=_join([fact_table.name, fact_table.display_name, " ".join(column_names)]),
        route_path=f"/p/{slug}/metrics/fact-tables/{fact_table.id}/edit",
    )
