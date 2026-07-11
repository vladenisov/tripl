"""Feature-branch journey builder.

Seeds a minimal but API-visible collaboration story: a base ``PlanRevision``
snapshot, one working ``PlanBranch`` (a feature branch — the kind enum is
main/working, so a working branch with a feature-style name), and a top-level
``PlanBranchComment``. Reachable via ``/branches``, ``/branches/{id}/comments``,
and ``/revisions``.

The ORM writes mirror ``plan_branch_service.create_branch`` inline because that
service commits internally, which would break the seeder's single end-of-function
commit. No plan deep-copy is done — the branch is intentionally minimal.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.plan_branch import BranchKind, BranchStatus, PlanBranch
from tripl.models.plan_branch_comment import PlanBranchComment
from tripl.models.plan_revision import PlanRevision
from tripl.services.demo.scenario import DemoContext
from tripl.services.plan_revision_service import build_plan_snapshot

_BRANCH_NAME = "feature/checkout-funnel"
_BRANCH_DESCRIPTION = "Redesign the checkout funnel: paywall copy and Buy CTA placement."
_COMMENT_BODY = (
    "Kicking off the checkout funnel redesign. First pass tightens the paywall "
    "copy and moves the Buy CTA above the fold — see the linked Figma spec."
)


async def build_branches(session: AsyncSession, ctx: DemoContext) -> None:
    # Merge base: a snapshot of the (now fully-seeded) main plan.
    base_payload = await build_plan_snapshot(session, ctx.project_id, branch_id=ctx.branch_id)
    base_revision = PlanRevision(
        project_id=ctx.project_id,
        created_by=ctx.created_by,
        summary=f"Base snapshot for branch '{_BRANCH_NAME}'",
        payload=base_payload,
    )
    session.add(base_revision)
    await session.flush()

    branch = PlanBranch(
        project_id=ctx.project_id,
        name=_BRANCH_NAME,
        kind=BranchKind.working.value,
        status=BranchStatus.draft.value,
        description=_BRANCH_DESCRIPTION,
        base_revision_id=base_revision.id,
        created_by=ctx.created_by,
    )
    session.add(branch)
    await session.flush()

    session.add(
        PlanBranchComment(
            branch_id=branch.id,
            parent_id=None,
            user_id=ctx.created_by,
            body=_COMMENT_BODY,
        )
    )
    await session.flush()
