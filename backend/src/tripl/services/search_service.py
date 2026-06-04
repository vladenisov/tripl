from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import re
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import cast

from sqlalchemy import bindparam, delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.config import settings
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_meta_value import EventMetaValue
from tripl.models.event_tag import EventTag
from tripl.models.event_type import EventType
from tripl.models.event_type_relation import EventTypeRelation
from tripl.models.field_definition import FieldDefinition
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.models.project import Project
from tripl.models.search_document import SearchDocument
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.schemas.search import SearchEntityType, SearchResponse, SearchResult
from tripl.services.embedding_service import embed_query
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug

logger = logging.getLogger(__name__)


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


def _dialect_name(session: AsyncSession) -> str:
    return session.get_bind().dialect.name


def _is_postgres(session: AsyncSession) -> bool:
    return _dialect_name(session) == "postgresql"


def _clean(value: object | None) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _join(parts: Sequence[object | None]) -> str:
    values = [_clean(part) for part in parts]
    return " ".join(value for value in values if value)


def _is_sensitive(sensitivity: str | None) -> bool:
    return (sensitivity or "none") != "none"


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value.casefold()).strip()


def _tokens(query: str) -> list[str]:
    return [token for token in re.split(r"\s+", _normalize(query)) if token]


def _safe_limit(limit: int) -> int:
    return max(1, min(limit, 10000))


def _doc_to_model(
    doc: BuiltDocument,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> SearchDocument:
    return SearchDocument(
        project_id=project_id,
        branch_id=branch_id,
        entity_type=doc.entity_type,
        entity_id=doc.entity_id,
        parent_event_id=doc.parent_event_id,
        title=doc.title,
        subtitle=doc.subtitle,
        description=doc.description,
        body=doc.body,
        keywords=doc.keywords,
        route_path=doc.route_path,
        archived=doc.archived,
        content_hash=doc.content_hash,
        embedding_status="pending" if settings.search_embeddings_enabled else "disabled",
        embedding_model=settings.search_embedding_model
        if settings.search_embeddings_enabled
        else None,
    )


async def reindex_branch(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID | None = None,
    *,
    schedule_embeddings: bool = True,
) -> int:
    project_id = await get_project_id_by_slug(session, slug)
    resolved_branch_id = await resolve_branch_id(session, project_id, branch_id)
    return await reindex_project_branch(
        session,
        project_id=project_id,
        branch_id=resolved_branch_id,
        slug=slug,
        schedule_embeddings=schedule_embeddings,
    )


async def reindex_project_branch(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str | None = None,
    schedule_embeddings: bool = True,
) -> int:
    project_slug = slug or await _project_slug(session, project_id)
    documents = await _build_documents(session, project_id, branch_id, project_slug)

    await session.execute(
        delete(SearchDocument).where(
            SearchDocument.project_id == project_id,
            SearchDocument.branch_id == branch_id,
        )
    )
    if documents:
        session.add_all(
            [_doc_to_model(doc, project_id=project_id, branch_id=branch_id) for doc in documents]
        )
    await session.flush()
    if _is_postgres(session):
        await _refresh_text_vectors(session, project_id, branch_id)
    await session.commit()

    if schedule_embeddings:
        _queue_embedding_refresh(project_id, branch_id)
    return len(documents)


async def search_project(
    session: AsyncSession,
    slug: str,
    query: str,
    *,
    branch_id: uuid.UUID | None = None,
    entity_types: list[SearchEntityType] | None = None,
    include_archived: bool = False,
    limit: int = 20,
) -> SearchResponse:
    normalized_query = query.strip()
    if not normalized_query:
        return SearchResponse(items=[], total=0, semantic_used=False)

    project_id = await get_project_id_by_slug(session, slug)
    resolved_branch_id = await resolve_branch_id(session, project_id, branch_id)
    await _ensure_index_exists(session, slug, project_id, resolved_branch_id)

    capped_limit = _safe_limit(limit)
    # Pull a few extra candidates for small interactive queries so the
    # event-type boost has room to promote events of a matching type into the
    # final window. Large/typed queries (e.g. bulk id lookups) are left as-is.
    candidate_limit = capped_limit
    if entity_types is None and capped_limit < 50:
        candidate_limit = _safe_limit(capped_limit + 24)

    if _is_postgres(session):
        items, semantic_used = await _postgres_search(
            session,
            project_id=project_id,
            branch_id=resolved_branch_id,
            query=normalized_query,
            entity_types=entity_types,
            include_archived=include_archived,
            limit=candidate_limit,
        )
    else:
        items = await _sqlite_search(
            session,
            project_id=project_id,
            branch_id=resolved_branch_id,
            query=normalized_query,
            entity_types=entity_types,
            include_archived=include_archived,
            limit=candidate_limit,
        )
        semantic_used = False

    items = _finalize_results(items, capped_limit)
    return SearchResponse(items=items, total=len(items), semantic_used=semantic_used)


async def search_event_ids(
    session: AsyncSession,
    slug: str,
    query: str,
    *,
    branch_id: uuid.UUID | None = None,
    include_archived: bool = True,
    limit: int = 10000,
) -> list[uuid.UUID]:
    response = await search_project(
        session,
        slug,
        query,
        branch_id=branch_id,
        entity_types=["event", "tag"],
        include_archived=include_archived,
        limit=limit,
    )
    event_ids: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for item in response.items:
        event_id = item.parent_event_id if item.parent_event_id is not None else item.entity_id
        if event_id not in seen:
            seen.add(event_id)
            event_ids.append(event_id)
    return event_ids


async def _project_slug(session: AsyncSession, project_id: uuid.UUID) -> str:
    project = await session.get(Project, project_id)
    if project is None:
        msg = f"Project {project_id} not found"
        raise ValueError(msg)
    return project.slug


async def _ensure_index_exists(
    session: AsyncSession,
    slug: str,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> None:
    exists = await session.scalar(
        select(SearchDocument.id)
        .where(SearchDocument.project_id == project_id, SearchDocument.branch_id == branch_id)
        .limit(1)
    )
    if exists is None:
        await reindex_project_branch(
            session,
            project_id=project_id,
            branch_id=branch_id,
            slug=slug,
            schedule_embeddings=False,
        )


async def _build_documents(
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
        route_path=f"/p/{slug}/events/detail/{event.id}",
        archived=event.archived,
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
        route_path=f"/p/{slug}/events/detail/{event.id}",
        archived=event.archived,
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


async def _refresh_text_vectors(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> None:
    await session.execute(
        text(
            """
            UPDATE search_documents
            SET text_vector = to_tsvector(
                'tripl_search',
                concat_ws(' ', title, subtitle, body, keywords)
            )
            WHERE project_id = :project_id AND branch_id = :branch_id
            """
        ),
        {"project_id": project_id, "branch_id": branch_id},
    )


def _queue_embedding_refresh(project_id: uuid.UUID, branch_id: uuid.UUID) -> bool:
    if not settings.search_embeddings_enabled:
        return False
    try:
        from tripl.worker.celery_app import celery_app

        celery_app.send_task(
            "tripl.worker.tasks.search.embed_search_documents",
            args=[str(project_id), str(branch_id)],
        )
    except Exception:
        logger.exception("Failed to queue search embedding refresh")
        return False
    return True


async def _postgres_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    query: str,
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
) -> tuple[list[SearchResult], bool]:
    lexical_results = await _postgres_lexical_search(
        session,
        project_id=project_id,
        branch_id=branch_id,
        query=query,
        entity_types=entity_types,
        include_archived=include_archived,
        limit=limit,
    )
    semantic_used = False
    semantic_results: list[SearchResult] = []
    if settings.search_embeddings_enabled and len(query) >= 3:
        query_embedding = await asyncio.to_thread(embed_query, query)
        if query_embedding:
            semantic_used = True
            semantic_results = await _postgres_semantic_search(
                session,
                project_id=project_id,
                branch_id=branch_id,
                embedding=query_embedding,
                entity_types=entity_types,
                include_archived=include_archived,
                limit=limit,
            )

    merged = _merge_results(lexical_results, semantic_results, limit)
    return merged, semantic_used


async def _postgres_lexical_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    query: str,
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
) -> list[SearchResult]:
    token_regex = _token_boundary_regex(query)
    has_token_regex = bool(token_regex)
    type_clause = "AND d.entity_type IN :entity_types" if entity_types else ""
    statement = text(
        f"""
        WITH q AS (
            SELECT websearch_to_tsquery('tripl_search', :query) AS tsq
        ),
        ranked AS (
            SELECT
                d.id,
                d.entity_type,
                d.entity_id,
                d.parent_event_id,
                d.title,
                d.subtitle,
                d.description,
                d.body,
                d.keywords,
                d.route_path,
                COALESCE(ts_rank_cd(d.text_vector, q.tsq), 0.0) AS lexical_score,
                GREATEST(
                    similarity(d.title, :query),
                    similarity(d.subtitle, :query),
                    similarity(d.keywords, :query),
                    similarity(d.body, :query) * 0.5
                ) AS fuzzy_score,
                CASE
                    WHEN lower(d.title) = lower(:query) THEN 5.0
                    WHEN lower(d.keywords) = lower(:query) THEN 4.0
                    WHEN :has_token_regex AND d.keywords ~* :token_regex THEN 3.5
                    WHEN :has_token_regex AND d.body ~* :token_regex THEN 3.0
                    WHEN lower(d.title) LIKE lower(:prefix) THEN 3.0
                    WHEN lower(d.body) LIKE lower(:contains) THEN 2.25
                    WHEN lower(d.keywords) LIKE lower(:contains) THEN 1.5
                    ELSE 0.0
                END AS boost
            FROM search_documents d
            CROSS JOIN q
            WHERE d.project_id = :project_id
              AND d.branch_id = :branch_id
              AND (:include_archived OR d.archived IS FALSE)
              {type_clause}
              AND (
                d.text_vector @@ q.tsq
                OR d.title % :query
                OR d.subtitle % :query
                OR d.keywords % :query
                OR lower(concat_ws(' ', d.title, d.subtitle, d.body, d.keywords))
                   LIKE lower(:contains)
              )
        )
        SELECT
            id,
            entity_type,
            entity_id,
            parent_event_id,
            title,
            subtitle,
            description,
            body,
            keywords,
            route_path,
            ((lexical_score * 4.0) + (fuzzy_score * 2.0) + boost) AS score
        FROM ranked
        ORDER BY score DESC, title ASC
        LIMIT :limit
        """
    )
    params: dict[str, object] = {
        "project_id": project_id,
        "branch_id": branch_id,
        "query": query,
        "prefix": f"{query}%",
        "contains": f"%{query}%",
        "token_regex": token_regex,
        "has_token_regex": has_token_regex,
        "include_archived": include_archived,
        "limit": limit,
    }
    if entity_types:
        statement = statement.bindparams(bindparam("entity_types", expanding=True))
        params["entity_types"] = list(entity_types)
    rows = (await session.execute(statement, params)).mappings().all()
    return [_row_to_result(row, query, semantic_used=False) for row in rows]


async def _postgres_semantic_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    embedding: list[float],
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
) -> list[SearchResult]:
    vector = "[" + ",".join(f"{value:.8f}" for value in embedding) + "]"
    type_clause = "AND d.entity_type IN :entity_types" if entity_types else ""
    statement = text(
        f"""
        SELECT
            d.id,
            d.entity_type,
            d.entity_id,
            d.parent_event_id,
            d.title,
            d.subtitle,
            d.description,
            d.body,
            d.keywords,
            d.route_path,
            (1.0 - (d.embedding <=> CAST(:embedding AS vector))) AS score
        FROM search_documents d
        WHERE d.project_id = :project_id
          AND d.branch_id = :branch_id
          AND (:include_archived OR d.archived IS FALSE)
          AND d.embedding IS NOT NULL
          AND d.embedding_status = 'ready'
          {type_clause}
        ORDER BY d.embedding <=> CAST(:embedding AS vector)
        LIMIT :limit
        """
    )
    if entity_types:
        statement = statement.bindparams(bindparam("entity_types", expanding=True))
    params: dict[str, object] = {
        "project_id": project_id,
        "branch_id": branch_id,
        "embedding": vector,
        "include_archived": include_archived,
        "limit": limit,
    }
    if entity_types:
        params["entity_types"] = list(entity_types)
    rows = (await session.execute(statement, params)).mappings().all()
    return [_row_to_result(row, "", semantic_used=True) for row in rows]


async def _sqlite_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    query: str,
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
) -> list[SearchResult]:
    statement = select(SearchDocument).where(
        SearchDocument.project_id == project_id,
        SearchDocument.branch_id == branch_id,
    )
    if entity_types:
        statement = statement.where(SearchDocument.entity_type.in_(entity_types))
    if not include_archived:
        statement = statement.where(SearchDocument.archived.is_(False))
    rows = list((await session.execute(statement)).scalars().all())
    scored: list[tuple[float, SearchDocument]] = []
    query_norm = _normalize(query)
    query_tokens = _tokens(query)
    for row in rows:
        haystack = _normalize(_join([row.title, row.subtitle, row.body, row.keywords]))
        score = _fallback_score(query_norm, query_tokens, haystack, row)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: (-item[0], item[1].title))
    return [
        _document_to_result(row, score, query, semantic_used=False) for score, row in scored[:limit]
    ]


def _fallback_score(
    query_norm: str,
    query_tokens: list[str],
    haystack: str,
    document: SearchDocument,
) -> float:
    if not query_norm:
        return 0.0
    title = _normalize(document.title)
    keywords = _normalize(document.keywords)
    if title == query_norm:
        return 10.0
    if keywords == query_norm:
        return 9.0
    if title.startswith(query_norm):
        return 7.0
    if _contains_exact_token(document.keywords or "", query_norm):
        return 6.8
    if _contains_exact_token(document.body or "", query_norm):
        return 6.5
    if query_norm in title or query_norm in keywords:
        return 6.0
    if query_norm in haystack:
        return 4.0
    if query_tokens and all(token in haystack for token in query_tokens):
        return 3.0
    similarity = SequenceMatcher(None, query_norm, title or haystack[:200]).ratio()
    return similarity * 2.0 if similarity >= 0.55 else 0.0


def _token_boundary_regex(query: str) -> str | None:
    normalized_query = _normalize(query)
    # PostgreSQL word boundaries (\m ... \M) reliably work for token-like
    # values such as "ecmwf" / "vip_segment". For phrase-like queries with
    # spaces or punctuation we keep regular LIKE/fuzzy logic.
    if not re.fullmatch(r"[a-z0-9_]+", normalized_query):
        return None
    return rf"\m{re.escape(normalized_query)}\M"


def _contains_exact_token(source: str, query_norm: str) -> bool:
    if not source or not query_norm:
        return False
    return re.search(rf"(^|[^\w]){re.escape(query_norm)}([^\w]|$)", _normalize(source)) is not None


def _merge_results(
    lexical_results: list[SearchResult],
    semantic_results: list[SearchResult],
    limit: int,
) -> list[SearchResult]:
    merged: dict[uuid.UUID, SearchResult] = {item.id: item for item in lexical_results}
    for item in semantic_results:
        existing = merged.get(item.id)
        semantic_score = max(0.0, item.score) * 2.5
        if existing is None:
            item.score = semantic_score
            item.semantic_used = True
            merged[item.id] = item
            continue
        existing.score += semantic_score
        existing.semantic_used = True
    return sorted(merged.values(), key=lambda item: (-item.score, item.title))[:limit]


# How strongly a matching event type lifts the events that belong to it.
_TYPE_BOOST_WEIGHT = 0.75


def _finalize_results(items: list[SearchResult], limit: int) -> list[SearchResult]:
    """Apply the cross-entity event-type boost, then rank, trim, and stamp each
    returned result with a confidence normalized to the top hit (0..1)."""
    boosted = _apply_event_type_boost(items)
    boosted.sort(key=lambda item: (-item.score, item.title))
    trimmed = boosted[:limit]
    top_score = trimmed[0].score if trimmed else 0.0
    if top_score > 0:
        for item in trimmed:
            item.confidence = round(min(1.0, max(0.0, item.score) / top_score), 4)
    return trimmed


def _apply_event_type_boost(items: list[SearchResult]) -> list[SearchResult]:
    """Lift events whose event type matches the query.

    When a descriptive query resolves to an event type (e.g. "экран спота"
    matching the ``pageviews`` type), every event of that type gets a
    multiplicative score boost proportional to how strongly the type matched.
    Type relevance is derived from the candidate set itself (the ``event_type``
    documents present in it), so this works for both the Postgres
    (lexical + semantic) and SQLite paths without an extra query.
    """
    type_scores: dict[str, float] = {}
    for item in items:
        if item.entity_type == "event_type":
            key = _normalize(item.title)
            if key:
                type_scores[key] = max(type_scores.get(key, 0.0), item.score)
    top_type = max(type_scores.values(), default=0.0)
    if top_type <= 0:
        return items
    for item in items:
        if item.entity_type != "event" or not item.subtitle:
            continue
        relevance = type_scores.get(_normalize(item.subtitle), 0.0) / top_type
        if relevance > 0:
            item.score *= 1.0 + _TYPE_BOOST_WEIGHT * relevance
    return items


def _row_to_result(row: object, query: str, *, semantic_used: bool) -> SearchResult:
    mapping = cast(Mapping[str, object], row)
    score_raw = mapping["score"]
    score = float(str(score_raw)) if score_raw is not None else 0.0
    return SearchResult(
        id=uuid.UUID(str(mapping["id"])),
        entity_type=cast(SearchEntityType, str(mapping["entity_type"])),
        entity_id=uuid.UUID(str(mapping["entity_id"])),
        parent_event_id=uuid.UUID(str(mapping["parent_event_id"]))
        if mapping["parent_event_id"] is not None
        else None,
        title=str(mapping["title"]),
        subtitle=str(mapping["subtitle"] or ""),
        description=str(mapping.get("description") or ""),
        snippet=_snippet(str(mapping["body"] or ""), query),
        route_path=str(mapping["route_path"]),
        score=score,
        highlights=_highlights(str(mapping["title"]), str(mapping["body"] or ""), query),
        semantic_used=semantic_used,
    )


def _document_to_result(
    document: SearchDocument,
    score: float,
    query: str,
    *,
    semantic_used: bool,
) -> SearchResult:
    return SearchResult(
        id=document.id,
        entity_type=cast(SearchEntityType, document.entity_type),
        entity_id=document.entity_id,
        parent_event_id=document.parent_event_id,
        title=document.title,
        subtitle=document.subtitle,
        description=document.description or "",
        snippet=_snippet(document.body, query),
        route_path=document.route_path,
        score=score,
        highlights=_highlights(document.title, document.body, query),
        semantic_used=semantic_used,
    )


def _snippet(body: str, query: str, *, length: int = 180) -> str:
    text_body = _clean(body)
    if not text_body:
        return ""
    query_norm = _normalize(query)
    body_norm = _normalize(text_body)
    idx = body_norm.find(query_norm) if query_norm else -1
    if idx < 0:
        return text_body[:length]
    start = max(0, idx - 60)
    end = min(len(text_body), start + length)
    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(text_body) else ""
    return f"{prefix}{text_body[start:end]}{suffix}"


def _highlights(title: str, body: str, query: str) -> list[str]:
    highlights: list[str] = []
    for token in _tokens(query)[:4]:
        for source in (title, body):
            source_norm = _normalize(source)
            idx = source_norm.find(token)
            if idx >= 0:
                highlights.append(source[max(0, idx - 20) : idx + len(token) + 40].strip())
                break
    return highlights


def sanitize_embedding(values: list[float]) -> list[float]:
    sanitized = [float(value) for value in values]
    if len(sanitized) != settings.search_embedding_dimensions:
        return []
    if any(not math.isfinite(value) for value in sanitized):
        return []
    return sanitized
