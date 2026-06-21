"""Search service — public API.

This module is the stable import surface for all callers.  Implementation is
split across two private sibling modules:

* ``_search_documents``  — document building / indexing helpers
* ``_search_query``      — querying, ranking, result shaping
"""

from __future__ import annotations

import logging
import math
import uuid

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.models.search_document import SearchDocument
from tripl.schemas.search import (
    SearchEntityType,
    SearchResponse,
    SearchResult,
)
from tripl.services import app_settings_service
from tripl.services._search_documents import (
    BuiltDocument,
    _clean,
    _join,
)
from tripl.services._search_documents import (
    build_documents as _build_documents,
)
from tripl.services._search_query import (
    _is_postgres,
    _safe_limit,
    document_to_result,
    fallback_score,
    highlights,
    merge_results,
    row_to_result,
    snippet,
)
from tripl.services._search_query import (
    enrich_event_hits as _enrich_event_hits,
)
from tripl.services._search_query import (
    finalize_results as _finalize_results,
)
from tripl.services._search_query import (
    postgres_search as _postgres_search,
)
from tripl.services._search_query import (
    sqlite_search as _sqlite_search,
)
from tripl.services._search_query import (
    token_boundary_regex as _token_boundary_regex,
)
from tripl.services.app_settings_service import AiConfig
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_service import get_project_id_by_slug

logger = logging.getLogger(__name__)

# Re-export types / helpers that tests and callers may reference directly.
__all__ = [
    "AiConfig",
    "BuiltDocument",
    "SearchEntityType",
    "SearchResponse",
    "SearchResult",
    "_clean",
    "_finalize_results",
    "_join",
    "_queue_embedding_refresh",
    "_reindex_branch_documents",
    "_token_boundary_regex",
    "document_to_result",
    "fallback_score",
    "highlights",
    "merge_results",
    "reindex_branch",
    "reindex_project_branch",
    "row_to_result",
    "sanitize_embedding",
    "search_event_ids",
    "search_project",
    "snippet",
]


def _doc_to_model(
    doc: BuiltDocument,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    ai_config: AiConfig,
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
        embedding_status="pending" if ai_config.search_embeddings_enabled else "disabled",
        embedding_model=ai_config.search_embedding_model
        if ai_config.search_embeddings_enabled
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


async def _reindex_branch_documents(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str | None = None,
) -> tuple[int, AiConfig]:
    """Rebuild the branch's search index in-place WITHOUT committing.

    Performs the DELETE + rebuild + flush (and the Postgres text-vector
    refresh) so the new index participates in the caller's transaction. The
    caller owns the commit; callers that mutate primary data first can thus
    cover the data write and the index rebuild in a single atomic transaction.

    Returns the document count and the resolved ``AiConfig`` so the caller can
    schedule the fire-and-forget embedding refresh *after* its commit succeeds.
    """
    project_slug = slug or await _project_slug(session, project_id)
    documents = await _build_documents(session, project_id, branch_id, project_slug)
    ai_config = await app_settings_service.get_ai_config(session)

    await session.execute(
        delete(SearchDocument).where(
            SearchDocument.project_id == project_id,
            SearchDocument.branch_id == branch_id,
        )
    )
    if documents:
        session.add_all(
            [
                _doc_to_model(
                    doc,
                    project_id=project_id,
                    branch_id=branch_id,
                    ai_config=ai_config,
                )
                for doc in documents
            ]
        )
    await session.flush()
    if _is_postgres(session):
        await _refresh_text_vectors(session, project_id, branch_id)
    return len(documents), ai_config


async def reindex_project_branch(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str | None = None,
    schedule_embeddings: bool = True,
) -> int:
    count, ai_config = await _reindex_branch_documents(
        session,
        project_id=project_id,
        branch_id=branch_id,
        slug=slug,
    )
    await session.commit()

    if schedule_embeddings:
        _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
    return count


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
    await _enrich_event_hits(
        session,
        items,
        project_id=project_id,
        branch_id=resolved_branch_id,
    )
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
    from tripl.models.project import Project

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
    from sqlalchemy import select

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


async def _refresh_text_vectors(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
) -> None:
    from sqlalchemy import text

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


def _queue_embedding_refresh(
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    *,
    ai_config: AiConfig,
) -> bool:
    if not ai_config.search_embeddings_enabled:
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


def sanitize_embedding(values: list[float]) -> list[float]:
    sanitized = [float(value) for value in values]
    if len(sanitized) != settings.search_embedding_dimensions:
        return []
    if any(not math.isfinite(value) for value in sanitized):
        return []
    return sanitized
