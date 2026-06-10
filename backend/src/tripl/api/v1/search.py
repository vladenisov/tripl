from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from tripl.api.deps import BranchIdDep, EditorUserDep, SessionDep
from tripl.schemas.search import SearchEntityType, SearchReindexResponse, SearchResponse
from tripl.services import app_settings_service, search_service

router = APIRouter(prefix="/projects/{slug}/search", tags=["search"])


@router.get("", response_model=SearchResponse)
async def search_project(
    session: SessionDep,
    slug: str,
    branch_id: BranchIdDep,
    q: Annotated[str, Query(min_length=1, max_length=500)],
    types: Annotated[list[SearchEntityType] | None, Query()] = None,
    include_archived: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> SearchResponse:
    return await search_service.search_project(
        session,
        slug,
        q,
        branch_id=branch_id,
        entity_types=types,
        include_archived=include_archived,
        limit=limit,
    )


@router.post("/reindex", response_model=SearchReindexResponse)
async def reindex_project_search(
    session: SessionDep,
    slug: str,
    branch_id: BranchIdDep,
    _current_user: EditorUserDep,
) -> SearchReindexResponse:
    documents_indexed = await search_service.reindex_branch(session, slug, branch_id)
    ai_config = await app_settings_service.get_ai_config(session)
    return SearchReindexResponse(
        documents_indexed=documents_indexed,
        embeddings_scheduled=ai_config.search_embeddings_enabled,
    )
