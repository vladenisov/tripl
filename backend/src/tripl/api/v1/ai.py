from __future__ import annotations

from fastapi import APIRouter, HTTPException

from tripl.api.deps import BranchIdDep, EditorUserDep, SessionDep
from tripl.schemas.ai import (
    AiAskRequest,
    AiAskResponse,
    AiDescribeEventRequest,
    AiDescribeEventTypeRequest,
    AiDescribeResponse,
    AiStatusResponse,
)
from tripl.services import ai_service, llm_service

router = APIRouter(prefix="/projects/{slug}/ai", tags=["ai"])


def _require_ai_enabled() -> None:
    if not llm_service.is_enabled():
        raise HTTPException(
            status_code=503,
            detail="AI features are disabled. Set AI_ENABLED=true and configure an API key.",
        )


@router.get("/status", response_model=AiStatusResponse)
async def ai_status(slug: str) -> AiStatusResponse:
    return AiStatusResponse(enabled=llm_service.is_enabled())


@router.post("/describe-event", response_model=AiDescribeResponse)
async def describe_event(
    session: SessionDep,
    slug: str,
    branch_id: BranchIdDep,
    payload: AiDescribeEventRequest,
    _current_user: EditorUserDep,
) -> AiDescribeResponse:
    _require_ai_enabled()
    return await ai_service.suggest_event_description(session, slug, payload.event_id, branch_id)


@router.post("/describe-event-type", response_model=AiDescribeResponse)
async def describe_event_type(
    session: SessionDep,
    slug: str,
    branch_id: BranchIdDep,
    payload: AiDescribeEventTypeRequest,
    _current_user: EditorUserDep,
) -> AiDescribeResponse:
    _require_ai_enabled()
    return await ai_service.suggest_event_type_descriptions(
        session,
        slug,
        payload.event_type_id,
        branch_id,
    )


@router.post("/ask", response_model=AiAskResponse)
async def ask_plan(
    session: SessionDep,
    slug: str,
    branch_id: BranchIdDep,
    payload: AiAskRequest,
) -> AiAskResponse:
    _require_ai_enabled()
    return await ai_service.ask_plan(session, slug, payload.question, branch_id)
