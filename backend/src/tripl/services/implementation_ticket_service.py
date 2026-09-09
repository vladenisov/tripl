from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.implementation_ticket import ImplementationTicket
from tripl.schemas.implementation_ticket import ImplementationTicketResponse
from tripl.services._branch_counterparts import main_counterparts
from tripl.services.event_service import get_event
from tripl.services.plan_branch_service import resolve_branch_id
from tripl.services.project_lookup import get_project_id_by_slug


async def list_branch_tickets(
    session: AsyncSession,
    slug: str,
    branch_id: uuid.UUID,
) -> list[ImplementationTicketResponse]:
    """Tracker tickets opened for one branch, oldest first.

    Read-only counterpart to the create-on-merge worker (tripl-hgez): the
    mapping was persisted but unreachable, so a user who merged a branch had no
    way back to the Jira issue it opened (tripl-2ayb).

    Scoping goes through :func:`plan_branch_service.resolve_branch_id` rather
    than a local ``branch.project_id == project_id`` check: it REUSES an
    existing ownership check instead of adding another one.

    Not the only one, though — the sibling branch routes (detail, diff,
    comments, conflicts, delete, transition, reviewers) go through
    ``plan_branch_service._get_branch``, a second spelling of the same
    predicate, and ``deps.get_branch_id_override`` is a third. Reusing one of
    those beats writing a fourth, which is all this choice claims.
    """
    project_id = await get_project_id_by_slug(session, slug)
    resolved_branch_id = await resolve_branch_id(session, project_id, branch_id)
    rows = (
        (
            await session.execute(
                select(ImplementationTicket)
                .where(ImplementationTicket.branch_id == resolved_branch_id)
                .order_by(ImplementationTicket.created_at)
            )
        )
        .scalars()
        .all()
    )
    return [ImplementationTicketResponse.model_validate(row) for row in rows]


async def list_event_tickets(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> list[ImplementationTicketResponse]:
    """Every tracker ticket that named this event, oldest first.

    The mapping already existed and nothing read it this way:
    ``uq_implementation_ticket_branch`` is one ticket per BRANCH, and
    ``event_ids`` lists the events that branch touched — so an event carried by
    three merged branches is named by three rows, and the only route asked
    "which tickets did this branch open?".

    Scoping borrows :func:`event_service.get_event` with ``strict_branch=False``,
    the predicate ``get_event_history`` already uses for the other per-event
    sub-resource list. That is a REUSE rather than a fourth spelling of the
    branch-ownership check the docstring above warns about — those three are all
    branch predicates and none of them fits a route with no branch in its path.
    ``get_event`` resolves the project itself and 404s on an id from another
    one, which is the leak that matters here.

    A branch copy reads through to its main twin, because ``event_ids`` holds
    MAIN ids and the history belongs to the event, not to one copy of it — the
    same rule the discussion follows.

    Filtering happens in Python on purpose: ``event_ids`` is a JSON column, and
    containment over it is spelled differently on every dialect this project
    runs on. The row count is the project's ticket count, one per merged
    branch, so the scan is bounded by something a person created by hand.
    """
    event = await get_event(session, slug, event_id, branch_id, strict_branch=False)
    project_id = event.project_id
    twins = await main_counterparts(session, project_id=project_id, events=[event])
    target_id = str(twins.get(event.id, event).id)
    rows = (
        (
            await session.execute(
                select(ImplementationTicket)
                .where(ImplementationTicket.project_id == project_id)
                .order_by(ImplementationTicket.created_at)
            )
        )
        .scalars()
        .all()
    )
    return [
        ImplementationTicketResponse.model_validate(row)
        for row in rows
        if target_id in (row.event_ids or [])
    ]
