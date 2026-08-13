from fastapi import APIRouter, Depends, HTTPException

from tripl.api.deps import (
    BranchIdDep,
    EditorUserDep,
    OwnerUserDep,
    SessionDep,
    get_owner_user,
)
from tripl.config import settings
from tripl.models.domain_enums import UserRole
from tripl.models.project import Project
from tripl.models.user import User
from tripl.schemas.project import (
    AnomalyResetCounts,
    DemoCancelResponse,
    DetectionResetPeriod,
    DriftResetCounts,
    ProjectCreate,
    ProjectResponse,
    ProjectUpdate,
    VariableRetirementCounts,
    VariableRetirementRequest,
)
from tripl.services import (
    audit_service,
    demo_service,
    detection_reset_service,
    project_service,
    variable_retirement_service,
)

router = APIRouter(prefix="/projects", tags=["projects"])

_owner_required = [Depends(get_owner_user)]


def _is_project_manager(user: User, project: Project) -> bool:
    """An instance owner, or the editor who created this project."""
    return user.role == UserRole.owner.value or project.created_by_user_id == user.id


def _require_demo_manager(user: User, project: Project) -> None:
    """Allow a demo's creator (any editor) or an owner to manage it.

    Resolves the create/delete permission mismatch: editors may create a demo,
    so a creator may also reset or delete the demo they made, while owners may
    manage any demo. Real projects stay owner-only for deletion.
    """
    if _is_project_manager(user, project):
        return
    raise HTTPException(
        status_code=403,
        detail="Only the demo creator or an owner can manage this demo",
    )


def _require_project_manager(user: User, project: Project) -> None:
    """Guard project-identity edits (name, slug, retention policy).

    The editor role is instance-wide, so without this any registered editor
    could rename or re-slug every project on the instance, including ones they
    have never touched (tripl-jfm3.19). There is no per-project membership model
    yet, so the honest owner set is: the instance owner, plus whoever created
    the project. Projects created before creators were recorded have no creator
    and are therefore owner-managed.
    """
    if _is_project_manager(user, project):
        return
    raise HTTPException(
        status_code=403,
        detail="Only the project creator or an owner can edit this project",
    )


def _require_demo_enabled() -> None:
    """Enforce the master rollback switch on demo PROVISIONING paths only.

    Both create and reset call this: a reset re-seeds a demo from scratch, so it
    provisions one too. Demo DELETE does not, so a workspace can always remove a
    demo it already has. Real project create/scan/delete never call this, so
    toggling the flag leaves every non-demo surface untouched.
    """
    if not settings.demo_enabled:
        raise HTTPException(status_code=403, detail="Demo provisioning is disabled")


@router.get("", response_model=list[ProjectResponse])
async def list_projects(session: SessionDep) -> list[ProjectResponse]:
    return await project_service.list_projects(session)


@router.post(
    "",
    response_model=ProjectResponse,
    status_code=201,
)
async def create_project(
    session: SessionDep, current_user: EditorUserDep, data: ProjectCreate
) -> ProjectResponse:
    # Record the creator so the editor who made a project keeps control of it
    # (see _require_project_manager) without needing an owner for every rename.
    return await project_service.create_project(session, data, created_by=current_user.id)


@router.post(
    "/demo",
    response_model=ProjectResponse,
    status_code=201,
)
async def create_demo_project(session: SessionDep, current_user: EditorUserDep) -> ProjectResponse:
    _require_demo_enabled()
    return await demo_service.create_demo_project(session, created_by=current_user.id)


@router.post("/demo/cancel", response_model=DemoCancelResponse)
async def cancel_demo_provisioning(
    session: SessionDep, current_user: EditorUserDep
) -> DemoCancelResponse:
    """Abandon this user's in-flight demo provision, if one is still seeding.

    Deliberately ungated by the kill switch: it only ever removes work. Declared
    before ``/demo/{slug}/reset`` so the literal path is never shadowed.
    """
    return await demo_service.request_demo_cancel(session, created_by=current_user.id)


@router.post("/demo/{slug}/reset", response_model=ProjectResponse)
async def reset_demo_project(
    session: SessionDep, current_user: EditorUserDep, slug: str
) -> ProjectResponse:
    """Re-seed a demo in place. Restricted to the demo's creator or an owner."""
    # Reset re-provisions the demo from scratch, so it IS a provisioning path and
    # the kill switch has to gate it too — otherwise flipping the switch off still
    # left a full re-seed one click away (tripl-2su6.16). Delete deliberately
    # stays ungated, so a workspace can never be stuck with a demo it can't remove.
    _require_demo_enabled()
    project = await project_service.get_project_by_slug(session, slug)
    if not project.is_demo:
        raise HTTPException(status_code=404, detail="Demo project not found")
    _require_demo_manager(current_user, project)
    return await demo_service.reset_demo_project(session, slug, created_by=current_user.id)


@router.delete("/demo/{slug}", status_code=204)
async def delete_demo_project(session: SessionDep, current_user: EditorUserDep, slug: str) -> None:
    """Delete a demo and its owned synthetic warehouse. Creator or owner only."""
    project = await project_service.get_project_by_slug(session, slug)
    if not project.is_demo:
        raise HTTPException(status_code=404, detail="Demo project not found")
    _require_demo_manager(current_user, project)
    await project_service.delete_project(session, slug)


@router.get("/{slug}", response_model=ProjectResponse)
async def get_project(session: SessionDep, slug: str) -> ProjectResponse:
    return await project_service.get_project(session, slug)


@router.patch("/{slug}", response_model=ProjectResponse)
async def update_project(
    session: SessionDep, current_user: EditorUserDep, slug: str, data: ProjectUpdate
) -> ProjectResponse:
    project = await project_service.get_project_by_slug(session, slug)
    _require_project_manager(current_user, project)
    return await project_service.update_project(session, slug, data)


@router.delete("/{slug}", status_code=204, dependencies=_owner_required)
async def delete_project(session: SessionDep, slug: str) -> None:
    await project_service.delete_project(session, slug)


@router.post("/{slug}/danger/reset-anomalies", response_model=AnomalyResetCounts)
async def reset_anomalies(
    session: SessionDep,
    current_user: OwnerUserDep,
    slug: str,
    period: DetectionResetPeriod,
) -> AnomalyResetCounts:
    """Owner-only: clear every anomaly (+ breakdown) in the project's period.

    Destructive and irreversible. Derived monitoring signals disappear with the
    anomalies they are computed from.
    """
    project = await project_service.get_project_by_slug(session, slug)
    counts = await detection_reset_service.reset_project_anomalies(
        session, project.id, before=period.before, after=period.after
    )
    await audit_service.record(
        session,
        user=current_user,
        action="project.reset_anomalies",
        target_type="project",
        target_id=project.id,
        target_name=project.name,
        project=project,
        payload={"before": period.before, "after": period.after, "counts": counts},
    )
    return AnomalyResetCounts(**counts)


@router.post("/{slug}/danger/reset-drifts", response_model=DriftResetCounts)
async def reset_drifts(
    session: SessionDep,
    current_user: OwnerUserDep,
    slug: str,
    period: DetectionResetPeriod,
) -> DriftResetCounts:
    """Owner-only: clear every schema + distribution drift in the project's period.

    Destructive and irreversible.
    """
    project = await project_service.get_project_by_slug(session, slug)
    counts = await detection_reset_service.reset_project_drifts(
        session, project.id, before=period.before, after=period.after
    )
    await audit_service.record(
        session,
        user=current_user,
        action="project.reset_drifts",
        target_type="project",
        target_id=project.id,
        target_name=project.name,
        project=project,
        payload={"before": period.before, "after": period.after, "counts": counts},
    )
    return DriftResetCounts(**counts)


@router.post(
    "/{slug}/danger/retire-unused-variables",
    response_model=VariableRetirementCounts,
)
async def retire_unused_variables(
    session: SessionDep,
    current_user: OwnerUserDep,
    slug: str,
    branch_id: BranchIdDep,
    data: VariableRetirementRequest,
) -> VariableRetirementCounts:
    """Owner-only: drop the variables a scan minted that nothing refers to.

    A scan creates a variable for every placeholder it discovers and has never
    retired one, so a project whose warehouse holds a JSON column keyed by
    user-typed text accumulates a row per key forever (tripl-10h4). This deletes
    only rows that a scan created, no human has edited, no event field value
    names, and that carry no observed context, drift or override — see
    ``core.variable_retirement`` for why "no observed context" alone is not
    enough to be safe.

    ``dry_run`` defaults to true, so the first call is always a preview. It
    returns the same counts the real pass would, broken down by why each
    surviving row was kept.
    """
    project = await project_service.get_project_by_slug(session, slug)
    counts = await variable_retirement_service.retire_unused_variables(
        session,
        project_id=project.id,
        branch_id=branch_id,
        slug=slug,
        mode=data.mode,
        dry_run=data.dry_run,
    )
    if not data.dry_run:
        await audit_service.record(
            session,
            user=current_user,
            action="project.retire_unused_variables",
            target_type="project",
            target_id=project.id,
            target_name=project.name,
            project=project,
            payload={"mode": data.mode, "counts": counts},
        )
    return VariableRetirementCounts(**counts)
