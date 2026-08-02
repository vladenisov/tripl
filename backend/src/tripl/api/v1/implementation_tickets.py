import uuid

from fastapi import APIRouter

from tripl.api.deps import SessionDep
from tripl.schemas.implementation_ticket import ImplementationTicketResponse
from tripl.services import implementation_ticket_service

router = APIRouter(
    prefix="/projects/{slug}/branches/{branch_id}/implementation-tickets",
    tags=["implementation-tickets"],
)


@router.get("", response_model=list[ImplementationTicketResponse])
async def list_branch_implementation_tickets(
    session: SessionDep, slug: str, branch_id: uuid.UUID
) -> list[ImplementationTicketResponse]:
    """Read-only: tickets are opened by the merge worker, never by a client.

    Auth matches the other branch reads — any authenticated project reader, via
    the router-level ``get_current_user`` dependency; no editor gate, because
    nothing here mutates.
    """
    return await implementation_ticket_service.list_branch_tickets(session, slug, branch_id)
