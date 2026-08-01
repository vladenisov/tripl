from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.implementation_ticket import ImplementationTicket
from tripl.schemas.implementation_ticket import ImplementationTicketResponse
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
