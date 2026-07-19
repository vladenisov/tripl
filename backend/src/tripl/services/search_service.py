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

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.models.project import Project
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


# Stale rows are deleted by primary key in bounded chunks so the ``IN ()``
# list stays a sane size for the driver/planner on large branches.
_REINDEX_DELETE_CHUNK = 500


def _embedding_state_reusable(
    *,
    status: str,
    model: str | None,
    enabled: bool,
    current_model: str,
    demo_fixture_model: str | None = None,
) -> bool:
    """Whether a content-unchanged row's embedding state fits the current config.

    See :func:`_reindex_branch_documents` for the full reasoning; in short,
    ``failed`` rows are never reused (so every reindex retries them) and
    ``ready`` rows are reused only under the same model.

    ``demo_fixture_model`` is set only for the keyless demo (embeddings
    disabled, demo project, fixture present): fixture-stamped rows are
    ``ready`` under the fixture's model, and dropping them on every reindex
    would defeat the incremental diff and open a committed window with no
    semantic-eligible rows.
    """
    if not enabled:
        if status == "ready" and demo_fixture_model is not None:
            return model == demo_fixture_model
        return status == "disabled"
    return status == "pending" or (status == "ready" and model == current_model)


async def _reindex_branch_documents(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    slug: str | None = None,
) -> tuple[int, AiConfig]:
    """Incrementally rebuild the branch's search index WITHOUT committing.

    Diffs the freshly built documents against the existing rows on the unique
    ``(entity_type, entity_id)`` key instead of delete-all + insert-all, so an
    unchanged row survives the reindex with its ``text_vector`` and embedding
    intact. A row is KEPT only when its ``content_hash`` equals the rebuilt
    document's hash — identical hash means identical searchable text, so the
    stored row (including its text vector and any ready embedding) can stay
    untouched — AND its embedding state is consistent with the current config:

    * embeddings disabled: only ``disabled`` rows are kept;
    * embeddings enabled: ``pending`` rows are kept (the queued refresh picks
      them up) and ``ready`` rows are kept only under the SAME model — a
      ``ready`` row under a different model is re-inserted as ``pending`` so
      the index never mixes vectors from different models;
    * ``failed`` rows are deliberately NOT kept, so any reindex retries them;
    * ``disabled`` rows are not kept once embeddings are enabled (they would
      otherwise never get embedded).

    Everything else is deleted and re-inserted with the status derived from
    the config (see ``_doc_to_model``). The work participates in the caller's
    transaction and the caller owns the commit; callers that mutate primary
    data first can thus cover the data write and the index rebuild in a single
    atomic transaction.

    Returns the document count and the resolved ``AiConfig`` so the caller can
    schedule the fire-and-forget embedding refresh *after* its commit succeeds.
    """
    project_slug = slug or await _project_slug(session, project_id)
    documents = await _build_documents(session, project_id, branch_id, project_slug)
    ai_config = await app_settings_service.get_ai_config(session)
    demo_fixture_model = await _demo_fixture_model(session, project_id, ai_config)

    existing_rows = (
        await session.execute(
            select(
                SearchDocument.id,
                SearchDocument.entity_type,
                SearchDocument.entity_id,
                SearchDocument.content_hash,
                SearchDocument.embedding_status,
                SearchDocument.embedding_model,
            ).where(
                SearchDocument.project_id == project_id,
                SearchDocument.branch_id == branch_id,
            )
        )
    ).all()
    existing = {(row.entity_type, row.entity_id): row for row in existing_rows}

    keep_ids: set[uuid.UUID] = set()
    to_insert: list[BuiltDocument] = []
    for doc in documents:
        row = existing.get((doc.entity_type, doc.entity_id))
        if (
            row is not None
            and row.content_hash == doc.content_hash
            and _embedding_state_reusable(
                status=row.embedding_status,
                model=row.embedding_model,
                enabled=ai_config.search_embeddings_enabled,
                current_model=ai_config.search_embedding_model,
                demo_fixture_model=demo_fixture_model,
            )
        ):
            keep_ids.add(row.id)
        else:
            to_insert.append(doc)

    delete_ids = [row.id for row in existing.values() if row.id not in keep_ids]
    for start in range(0, len(delete_ids), _REINDEX_DELETE_CHUNK):
        chunk = delete_ids[start : start + _REINDEX_DELETE_CHUNK]
        await session.execute(delete(SearchDocument).where(SearchDocument.id.in_(chunk)))
    if to_insert:
        session.add_all(
            [
                _doc_to_model(
                    doc,
                    project_id=project_id,
                    branch_id=branch_id,
                    ai_config=ai_config,
                )
                for doc in to_insert
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

    if await _apply_demo_search_embeddings(
        session,
        project_id=project_id,
        branch_id=branch_id,
        ai_config=ai_config,
    ):
        await session.commit()

    if schedule_embeddings:
        _queue_embedding_refresh(project_id, branch_id, ai_config=ai_config)
    return count


async def _demo_fixture_model(
    session: AsyncSession,
    project_id: uuid.UUID,
    ai_config: AiConfig,
) -> str | None:
    """Fixture model whose stamped rows the incremental reindex may reuse.

    Non-``None`` only for the keyless demo case (embeddings disabled, Postgres,
    demo project, fixture present) — everywhere else the plain
    :func:`_embedding_state_reusable` rules apply unchanged.
    """
    if ai_config.search_embeddings_enabled or not _is_postgres(session):
        return None
    is_demo = await session.scalar(select(Project.is_demo).where(Project.id == project_id))
    if not is_demo:
        return None
    from tripl.services.demo.search_embeddings import load_demo_embedding_fixture

    fixture = load_demo_embedding_fixture()
    return fixture.model if fixture is not None else None


async def _apply_demo_search_embeddings(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID,
    ai_config: AiConfig,
) -> int:
    """Keyless demo semantic search: stamp precomputed fixture vectors.

    Postgres + demo projects only. Covers every path through
    :func:`reindex_project_branch` — demo provisioning/reset, the lazily built
    demo feature-branch index, and manual reindex. A missing or stale fixture
    makes this a no-op and the demo stays lexical-only, exactly as before.

    When live embeddings are enabled under a model DIFFERENT from the
    fixture's, stamping is skipped entirely: flipping the freshly inserted
    ``pending`` rows to ``ready`` with fixture vectors would hide them from
    the embedding worker and cosine-rank live query vectors against another
    model's vector space. The queued worker embeds them instead.
    """
    if not _is_postgres(session):
        return 0
    is_demo = await session.scalar(select(Project.is_demo).where(Project.id == project_id))
    if not is_demo:
        return 0
    from tripl.services.demo.search_embeddings import (
        apply_demo_embedding_fixture,
        load_demo_embedding_fixture,
    )

    fixture = load_demo_embedding_fixture()
    if fixture is None:
        return 0
    if ai_config.search_embeddings_enabled and ai_config.search_embedding_model != fixture.model:
        return 0
    return await apply_demo_embedding_fixture(
        session,
        project_id=project_id,
        branch_id=branch_id,
    )


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
        project_is_demo = bool(
            await session.scalar(select(Project.is_demo).where(Project.id == project_id))
        )
        items, semantic_used = await _postgres_search(
            session,
            project_id=project_id,
            branch_id=resolved_branch_id,
            query=normalized_query,
            entity_types=entity_types,
            include_archived=include_archived,
            limit=candidate_limit,
            project_is_demo=project_is_demo,
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

    # Only freshly inserted rows need vectorizing: rows kept by the
    # incremental reindex have an unchanged searchable text (identical
    # content_hash) and therefore still carry a valid text_vector.
    await session.execute(
        text(
            """
            UPDATE search_documents
            SET text_vector = to_tsvector(
                'tripl_search',
                concat_ws(' ', title, subtitle, body, keywords)
            )
            WHERE project_id = :project_id AND branch_id = :branch_id
              AND text_vector IS NULL
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
