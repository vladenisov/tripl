"""Main-branch scoping for worker queries.

Scans and metrics collection always operate on a project's MAIN plan, but
working branches carry deep-copied EventType/Event rows under the same names
(e.g. the seeded demo branch since recipe 4). Any by-name lookup that ignores
``branch_id`` therefore returns multiple rows once a branch exists.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.models.plan_branch import BranchKind, PlanBranch


def main_branch_id(session: Session, project_id: uuid.UUID) -> uuid.UUID | None:
    """Return the id of the project's main plan branch, or None before one exists.

    A None result is safe to use in an equality filter: plan tables carry
    NOT NULL ``branch_id``, so rows can only exist once the main branch does.
    """
    return session.scalar(
        select(PlanBranch.id).where(
            PlanBranch.project_id == project_id,
            PlanBranch.kind == BranchKind.main.value,
        )
    )
