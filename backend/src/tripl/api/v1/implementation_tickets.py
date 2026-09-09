import uuid

from fastapi import APIRouter

from tripl.api.deps import BranchIdDep, SessionDep
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


# A second router in the same module: the whole ticket READ surface stays in
# one file, and the auth note above serves both — neither route mutates, so
# neither carries an editor gate.
event_router = APIRouter(
    prefix="/projects/{slug}/events/{event_id}/implementation-tickets",
    tags=["implementation-tickets"],
)


@event_router.get("", response_model=list[ImplementationTicketResponse])
async def list_event_implementation_tickets(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    branch_id: BranchIdDep,
) -> list[ImplementationTicketResponse]:
    """The tickets that named this event, across every branch that merged.

    Shows history; it does not replace the editable meta field. Rows only exist
    where the Jira integration is enabled and a branch has merged.
    """
    return await implementation_ticket_service.list_event_tickets(
        session, slug, event_id, branch_id
    )
