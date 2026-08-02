"""Search querying, ranking, and result shaping.

Contains the Postgres (lexical + semantic) and SQLite search paths, result
merging/boosting, event-hit enrichment, and response-shaping helpers.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from collections.abc import Mapping
from difflib import SequenceMatcher
from typing import cast

from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.event import Event
from tripl.models.field_definition import FieldDefinition
from tripl.models.search_document import SearchDocument
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.schemas.search import (
    SearchEntityType,
    SearchEventVariableValue,
    SearchResult,
)
from tripl.schemas.text_filters import strip_nul_bytes
from tripl.services import app_settings_service
from tripl.services.demo.search_embeddings import demo_query_embedding
from tripl.services.embedding_service import embed_query

# How strongly a matching event type lifts the events that belong to it.
_TYPE_BOOST_WEIGHT = 0.75


def sanitize_query(query: str) -> str:
    """Trim the incoming query and drop codepoints no backend can carry.

    Postgres ``text`` cannot represent U+0000, so a query containing one aborts
    inside the driver (``asyncpg.exceptions.CharacterNotInRepertoireError``)
    before any SQL runs — ``?q=%00``, the first thing a routine security scan
    sends, used to surface as a 500 for any authenticated caller (tripl-q4q7).

    We strip rather than reject with 422 because stripping is *lossless here*:
    an indexed document cannot contain a NUL either (same column type, same
    restriction), so removing it cannot change which rows match or how they
    rank. The user who pasted text with a stray NUL gets the results they meant
    and no API client loses behaviour it could have relied on — the surprise
    argument against silently rewriting a query has no bite when the rewrite is
    provably a no-op on the result set. That reasoning does NOT generalise:
    anything with search meaning must survive, which is why this removes
    exactly U+0000 and leaves every other character alone.

    A query made only of NULs collapses to ``""`` and then takes the same
    empty-result path a whitespace-only query already took.

    The NUL removal itself now lives in ``schemas.text_filters``, where a route
    parameter type applies the identical rule to every other free-text filter
    (tripl-8wez). One rule, one implementation; this function adds only the
    whitespace trim, which is a search concern rather than a driver one.
    """
    cleaned: str = strip_nul_bytes(query)
    return cleaned.strip()


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value.casefold()).strip()


def _tokens(query: str) -> list[str]:
    return [token for token in re.split(r"\s+", _normalize(query)) if token]


def _safe_limit(limit: int) -> int:
    return max(1, min(limit, 10000))


def _is_postgres(session: AsyncSession) -> bool:
    return session.bind.dialect.name == "postgresql"


async def postgres_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    query: str,
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
    project_is_demo: bool = False,
) -> tuple[list[SearchResult], bool]:
    lexical_results = await postgres_lexical_search(
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
    ai_config = await app_settings_service.get_ai_config(session)
    if ai_config.search_embeddings_enabled and len(query) >= 3:
        query_embedding = await asyncio.to_thread(embed_query, query, config=ai_config)
        if query_embedding:
            semantic_used = True
            semantic_results = await postgres_semantic_search(
                session,
                project_id=project_id,
                branch_id=branch_id,
                embedding=query_embedding,
                entity_types=entity_types,
                include_archived=include_archived,
                limit=limit,
            )

    # Keyless demo fallback: when the live semantic leg is unavailable
    # (embeddings disabled, or the embed call failed/returned empty), a demo
    # project can still run the semantic leg with a canned query vector from
    # the precomputed fixture. Non-demo projects are unaffected.
    if not semantic_used and project_is_demo and len(query) >= 3:
        demo_embedding = demo_query_embedding(query)
        if demo_embedding:
            semantic_used = True
            semantic_results = await postgres_semantic_search(
                session,
                project_id=project_id,
                branch_id=branch_id,
                embedding=demo_embedding,
                entity_types=entity_types,
                include_archived=include_archived,
                limit=limit,
            )

    merged = merge_results(lexical_results, semantic_results, limit)
    return merged, semantic_used


async def postgres_lexical_search(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    query: str,
    entity_types: list[SearchEntityType] | None,
    include_archived: bool,
    limit: int,
) -> list[SearchResult]:
    token_regex = token_boundary_regex(query)
    has_token_regex = bool(token_regex)
    statement = text(
        """
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
              AND (:filter_entity_types IS FALSE OR d.entity_type IN :entity_types)
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
    filter_entity_types = bool(entity_types)
    statement = statement.bindparams(bindparam("entity_types", expanding=True))
    params: dict[str, object] = {
        "project_id": project_id,
        "branch_id": branch_id,
        "query": query,
        "prefix": f"{query}%",
        "contains": f"%{query}%",
        "token_regex": token_regex,
        "has_token_regex": has_token_regex,
        "include_archived": include_archived,
        "filter_entity_types": filter_entity_types,
        # An expanding bindparam cannot expand an empty list, so feed a single
        # placeholder when no type filter is active — the boolean flag above
        # short-circuits the IN clause, so the placeholder is never compared.
        "entity_types": list(entity_types) if entity_types else [""],
        "limit": limit,
    }
    rows = (await session.execute(statement, params)).mappings().all()
    return [row_to_result(row, query, semantic_used=False) for row in rows]


async def postgres_semantic_search(
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
    statement = text(
        """
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
          AND (:filter_entity_types IS FALSE OR d.entity_type IN :entity_types)
        ORDER BY d.embedding <=> CAST(:embedding AS vector)
        LIMIT :limit
        """
    )
    filter_entity_types = bool(entity_types)
    statement = statement.bindparams(bindparam("entity_types", expanding=True))
    params: dict[str, object] = {
        "project_id": project_id,
        "branch_id": branch_id,
        "embedding": vector,
        "include_archived": include_archived,
        "filter_entity_types": filter_entity_types,
        # See postgres_lexical_search: a placeholder list keeps the expanding
        # bindparam valid; the boolean flag short-circuits the IN clause.
        "entity_types": list(entity_types) if entity_types else [""],
        "limit": limit,
    }
    rows = (await session.execute(statement, params)).mappings().all()
    return [row_to_result(row, "", semantic_used=True) for row in rows]


async def sqlite_search(
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
        haystack = _normalize(_join_str([row.title, row.subtitle, row.body, row.keywords]))
        score = fallback_score(query_norm, query_tokens, haystack, row)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: (-item[0], item[1].title))
    return [
        document_to_result(row, score, query, semantic_used=False) for score, row in scored[:limit]
    ]


def _join_str(parts: list[str | None]) -> str:
    return " ".join(p for p in parts if p)


def fallback_score(
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


def token_boundary_regex(query: str) -> str | None:
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


def merge_results(
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


def finalize_results(items: list[SearchResult], limit: int) -> list[SearchResult]:
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


async def enrich_event_hits(
    session: AsyncSession,
    items: list[SearchResult],
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> None:
    event_ids: set[uuid.UUID] = set()
    for item in items:
        if item.parent_event_id is not None:
            event_ids.add(item.parent_event_id)
    if not event_ids:
        return

    rows = (
        await session.execute(
            select(Event.id, Event.name, Event.status).where(
                Event.project_id == project_id,
                Event.branch_id == branch_id,
                Event.id.in_(event_ids),
            )
        )
    ).all()
    events_by_id: dict[uuid.UUID, tuple[str, str]] = {
        event_id: (name, status) for event_id, name, status in rows
    }

    variable_rows = (
        await session.execute(
            select(
                VariableValue.id,
                VariableValue.event_id,
                VariableValue.variable_id,
                Variable.name,
                VariableValue.field_definition_id,
                FieldDefinition.name,
                FieldDefinition.display_name,
                VariableValue.source_column,
                VariableValue.value_kind,
                VariableValue.observed_count,
                VariableValue.values,
            )
            .join(Variable, VariableValue.variable_id == Variable.id)
            .join(FieldDefinition, VariableValue.field_definition_id == FieldDefinition.id)
            .where(
                VariableValue.project_id == project_id,
                VariableValue.branch_id == branch_id,
                VariableValue.event_id.in_(event_ids),
                FieldDefinition.sensitivity == "none",
            )
            .order_by(
                VariableValue.event_id.asc(),
                FieldDefinition.order.asc(),
                FieldDefinition.name.asc(),
                Variable.name.asc(),
            )
        )
    ).all()
    variable_values_by_event: dict[uuid.UUID, list[SearchEventVariableValue]] = {}
    for (
        context_id,
        event_id,
        variable_id,
        variable_name,
        field_definition_id,
        field_name,
        field_display_name,
        source_column,
        value_kind,
        observed_count,
        values,
    ) in variable_rows:
        variable_values_by_event.setdefault(event_id, []).append(
            SearchEventVariableValue(
                id=context_id,
                variable_id=variable_id,
                variable_name=variable_name,
                field_definition_id=field_definition_id,
                field_name=field_name,
                field_display_name=field_display_name,
                source_column=source_column,
                value_kind=value_kind,
                observed_count=observed_count,
                values=list(values or []),
            )
        )

    for item in items:
        if item.parent_event_id is None:
            continue
        event_state = events_by_id.get(item.parent_event_id)
        if event_state is None:
            continue
        name, status = event_state
        item.event_id = item.parent_event_id
        item.name = name
        item.implemented = status in ("implemented", "live")
        item.variable_values = variable_values_by_event.get(item.parent_event_id, [])


def row_to_result(row: object, query: str, *, semantic_used: bool) -> SearchResult:
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
        snippet=snippet(str(mapping["body"] or ""), query),
        route_path=str(mapping["route_path"]),
        score=score,
        highlights=highlights(str(mapping["title"]), str(mapping["body"] or ""), query),
        semantic_used=semantic_used,
    )


def document_to_result(
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
        snippet=snippet(document.body, query),
        route_path=document.route_path,
        score=score,
        highlights=highlights(document.title, document.body, query),
        semantic_used=semantic_used,
    )


def snippet(body: str, query: str, *, length: int = 180) -> str:
    from tripl.services._search_documents import _clean

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


def highlights(title: str, body: str, query: str) -> list[str]:
    result: list[str] = []
    for token in _tokens(query)[:4]:
        for source in (title, body):
            source_norm = _normalize(source)
            idx = source_norm.find(token)
            if idx >= 0:
                result.append(source[max(0, idx - 20) : idx + len(token) + 40].strip())
                break
    return result
