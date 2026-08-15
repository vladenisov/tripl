"""Document building helpers for the search index.

Converts project entities (event types, events, fields, variables, relations,
tags, metrics, fact tables) into ``BuiltDocument`` instances ready to be
stored as ``SearchDocument`` rows.
"""

from __future__ import annotations

import hashlib
import re
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


#: What glues an identifier together in this product: ``screen_spot``,
#: ``page_data.extra.spot_id``, ``properties.session_key``.
_IDENTIFIER_SEPARATORS = re.compile(r"[._]+")


def _spaced_identifiers(values: Sequence[object | None]) -> str:
    """Space-separated aliases for the snake_case / dotted names in ``values``.

    INDEX-TIME HALF OF tripl-h9x2
    -----------------------------
    Entities are named ``screen_spot`` and people type ``screen spot``. The
    tsvector already survives that (the text-search parser splits on ``_``), but
    the ranking's boost ladder does not: its tiers are ``LIKE``/regex
    comparisons against the STORED text, so ``lower(title) = 'screen spot'``,
    ``LIKE 'screen spot%'`` and ``LIKE '%screen spot%'`` all miss a title that is
    spelled ``screen_spot``. Measured: ``q='screen spot'`` ranked the
    ``screen_spot`` event 5th at 4.545.

    So each identifier is ALSO indexed in its spaced form. Together with the
    query-time half (``_search_query.token_boundary_regex`` folds a spaced query
    into the underscored form) the two spellings reach each other from either
    side. Two properties are load-bearing:

    * only the ALIAS is added, once per distinct identifier and only when it
      actually differs — this is not a second copy of the document text, which
      would feed the very term-frequency inflation tripl-gbxj is about;
    * it is applied to ``keywords`` and never to a tag document, whose
      ``keywords`` is exactly ``tag.name`` and is compared for EQUALITY by the
      4.0 tier — appending anything there would silently delete that tier.

    Dots are folded in the same pass (``page_data.extra.spot_id`` ->
    ``page data extra spot id``) because the text-search parser classifies a
    dotted name as a single host-like token and indexes it WHOLE — unlike the
    underscore, which it splits — so without the alias a search for ``spot_id``
    cannot reach the variable literally called ``page_data.extra.spot_id``.
    """
    aliases: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = _clean(value)
        if not cleaned:
            continue
        spaced = _IDENTIFIER_SEPARATORS.sub(" ", cleaned).strip()
        if not spaced or spaced == cleaned or spaced in seen:
            continue
        seen.add(spaced)
        aliases.append(spaced)
    return " ".join(aliases)


# Cap on the text embedded per document. The embedding model accepts 8191
# tokens; 6000 characters stays safely under that even for Cyrillic-heavy
# content (low chars-per-token). The 16k per-text cap in embedding_service
# remains as a backstop.
EMBED_TEXT_MAX_CHARS = 6000


def embed_text_for(*, title: str, subtitle: str, keywords: str, body: str) -> str:
    """Build the text that gets embedded for one search document.

    Single source of truth for the embed-text recipe — the worker task and the
    demo embedding fixture pipeline both call this, so the two can never drift.
    Keywords come BEFORE the potentially huge body so that truncation drops
    the low-signal text first, and the joined text is capped at
    ``EMBED_TEXT_MAX_CHARS`` characters.
    """
    joined = "\n".join([title, subtitle, keywords, body]).strip()
    return joined[:EMBED_TEXT_MAX_CHARS]


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
    # Sorted deterministically: the demo embedding fixture keys documents by
    # sha256(embed_text), so text joined from these rows must not depend on
    # dialect-specific row order (SQLite fixture generation vs Postgres
    # runtime) — the query itself has no ORDER BY.
    variable_values = sorted(
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
        .all(),
        key=_variable_value_sort_key,
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
        keywords=_join(
            [
                event_type.name,
                event_type.display_name,
                _spaced_identifiers([event_type.name]),
            ]
        ),
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
        keywords=_join(
            [
                field.name,
                field.display_name,
                event_type.name,
                event_type.display_name,
                _spaced_identifiers([field.name, event_type.name]),
            ]
        ),
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
        keywords=_join(
            [
                meta_field.name,
                meta_field.display_name,
                _spaced_identifiers([meta_field.name]),
            ]
        ),
        route_path=f"/p/{slug}/settings/meta-fields",
    )


def _variable_value_sort_key(context: VariableValue) -> tuple[str, str, str, str, str]:
    return (
        _clean(context.variable.name),
        _clean(context.event.name),
        _clean(context.field_definition.name),
        _clean(context.source_column),
        _clean(context.value_kind),
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
    # field_values / meta_values / tags are selectin relationships with no
    # order_by; iterate them sorted so the embed text (and therefore the demo
    # fixture's sha256 key) is identical across dialects.
    for field_value in sorted(
        event.field_values,
        key=lambda item: (item.field_definition.order, item.field_definition.name),
    ):
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
    for meta_value in sorted(event.meta_values, key=lambda item: item.meta_field_definition.name):
        meta_field = meta_value.meta_field_definition
        meta_names.extend([meta_field.name, meta_field.display_name])
        if not _is_sensitive(meta_field.sensitivity):
            safe_meta_values.append(meta_value.value)

    tag_names = sorted(tag.name for tag in event.tags)
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
                _spaced_identifiers([event.name, event.source_name]),
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
        # Deliberately NOT run through ``_spaced_identifiers`` (tripl-h9x2): a
        # tag document's keywords are exactly the tag name, which is what the
        # 4.0 "keywords ARE the query" tier compares for equality. Appending an
        # alias here would delete that tier for every tag.
        keywords=tag.name,
        route_path=f"/p/{slug}/monitoring/event/{event.id}",
        archived=(event.status == "archived"),
    )


def _variable_document(
    variable: Variable,
    slug: str,
    contexts: list[VariableValue],
) -> BuiltDocument:
    """Build the search document for one variable.

    HARVESTED VALUES ARE BODY TEXT, NOT KEYWORDS (tripl-gbxj)
    ---------------------------------------------------------
    A variable is bound to many (event, field) contexts, and every context
    repeats the variable name, the event name, the source column AND all of its
    observed values. This document used to put that text into ``body`` and into
    ``keywords``, and then append a deduplicated copy of the values on top — so
    a value appeared roughly ``2 * contexts + 1`` times in the indexed text of a
    single document, while the entity actually named after it appeared once.

    That is what an unbounded ``ts_rank_cd`` was multiplying (see
    ``_search_query.postgres_lexical_search``). Measured: one production project
    holds 1526 auto-detected "variables" that are really harvested field values,
    and ``q='spot'`` returned ``${property.spot_id}`` at 73.69 and
    ``${property.cube}`` at 55.68 — the latter only because one harvested value
    is ``spot:reload:bento`` — while the events named ``spot`` and
    ``screen_spot`` did not appear at all.

    Keywords are the high-weight field, and a value someone's app happened to
    emit is not a keyword of the variable: the variable's own name, the columns
    it comes from and the events it is bound to are. So the values stay in
    ``body`` — searching a concrete observed value still finds both the variable
    and its owning event, which is behaviour the product documents — and they
    are simply no longer joined into ``keywords``. Both halves of tripl-gbxj had
    to land together: the measured 73.69-vs-4.55 gap was the duplication and the
    missing normalization compounding.
    """
    context_text = _variable_context_text(contexts, include_event_names=True)
    context_keywords = _variable_context_text(
        contexts,
        include_event_names=True,
        include_values=False,
    )
    return BuiltDocument(
        entity_type="variable",
        entity_id=variable.id,
        parent_event_id=None,
        title=f"${{{variable.name}}}",
        subtitle=variable.variable_type,
        description=_clean(variable.description),
        body=_join([variable.name, variable.source_name, variable.description, context_text]),
        keywords=_join(
            [
                variable.name,
                variable.source_name,
                context_keywords,
                _spaced_identifiers([variable.name, variable.source_name]),
            ]
        ),
        route_path=f"/p/{slug}/settings/variables",
    )


def _variable_context_text(
    contexts: list[VariableValue],
    *,
    include_event_names: bool,
    include_values: bool = True,
) -> str:
    """Flatten a variable's bindings into indexable text.

    ``include_values=False`` yields the same text without the observed values,
    which is what a variable's ``keywords`` is built from (tripl-gbxj): the
    binding is a keyword of the variable, the harvested value is not. Sensitive
    fields never contribute values under either setting.
    """
    parts: list[str] = []
    for context in contexts:
        field = context.field_definition
        include_field_values = include_values and not _is_sensitive(field.sensitivity)
        safe_values = " ".join(context.values or []) if include_field_values else ""
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
        keywords=_join(
            [
                relation.relation_type,
                source_field.name,
                target_field.name,
                _spaced_identifiers([source_field.name, target_field.name]),
            ]
        ),
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
        keywords=_join(
            [
                metric.name,
                metric.display_name,
                metric.unit,
                metric.kind,
                _spaced_identifiers([metric.name]),
            ]
        ),
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
        keywords=_join(
            [
                fact_table.name,
                fact_table.display_name,
                " ".join(column_names),
                _spaced_identifiers([fact_table.name, *column_names]),
            ]
        ),
        route_path=f"/p/{slug}/metrics/fact-tables/{fact_table.id}/edit",
    )
