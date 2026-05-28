import uuid

from fastapi import APIRouter

from tripl.api.deps import BranchIdDep, EditorUserDep, SessionDep
from tripl.models.event_type_relation import EventTypeRelation
from tripl.schemas.relation import RelationCreate, RelationResponse
from tripl.services import audit_service, relation_service

router = APIRouter(prefix="/projects/{slug}/relations", tags=["relations"])


@router.get("", response_model=list[RelationResponse])
async def list_relations(
    session: SessionDep, slug: str, branch_id: BranchIdDep
) -> list[EventTypeRelation]:
    return await relation_service.list_relations(session, slug, branch_id)


@router.post("", response_model=RelationResponse, status_code=201)
async def create_relation(
    session: SessionDep,
    slug: str,
    data: RelationCreate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> EventTypeRelation:
    rel = await relation_service.create_relation(session, slug, data, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="relation.create",
        target_type="relation",
        target_id=rel.id,
        # Relations don't have a standalone name — fk ids land in the payload.
        project_slug=slug,
        payload=data.model_dump(),
    )
    return rel


@router.delete("/{relation_id}", status_code=204)
async def delete_relation(
    session: SessionDep,
    slug: str,
    relation_id: uuid.UUID,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> None:
    await relation_service.delete_relation(session, slug, relation_id, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="relation.delete",
        target_type="relation",
        target_id=relation_id,
        project_slug=slug,
    )
