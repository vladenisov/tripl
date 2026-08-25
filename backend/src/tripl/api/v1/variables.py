import uuid
from typing import Literal

from fastapi import APIRouter, Query

from tripl.api.deps import BranchIdDep, EditorUserDep, SessionDep
from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.models.variable_value import VariableValue
from tripl.schemas.variable import (
    VariableBulkDelete,
    VariableBulkUpdate,
    VariableCreate,
    VariableEventOverrideResponse,
    VariableEventOverrideUpsert,
    VariableListResponse,
    VariableResponse,
    VariableUpdate,
    VariableValueContextResponse,
)
from tripl.schemas.variable_value_drift import (
    VariableValueDriftActionRequest,
    VariableValueDriftListResponse,
    VariableValueDriftResponse,
)
from tripl.services import (
    audit_service,
    variable_service,
    variable_value_drift_service,
    variable_value_service,
)

router = APIRouter(prefix="/projects/{slug}/variables", tags=["variables"])

DEFAULT_PAGE_SIZE = 200
MAX_PAGE_SIZE = 5000


@router.post("/bulk-update", status_code=204)
async def bulk_update_variables(
    session: SessionDep,
    slug: str,
    data: VariableBulkUpdate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> None:
    await variable_service.bulk_update_variables(session, slug, data, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.bulk_update",
        target_type="variable",
        target_id=None,
        project_slug=slug,
        payload=data.model_dump(mode="json", exclude_none=True),
    )


@router.post("/bulk-delete", status_code=204)
async def bulk_delete_variables(
    session: SessionDep,
    slug: str,
    data: VariableBulkDelete,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> None:
    await variable_service.bulk_delete_variables(session, slug, data, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.bulk_delete",
        target_type="variable",
        target_id=None,
        project_slug=slug,
        payload=data.model_dump(mode="json"),
    )


# Registered before the /{variable_id} routes so the literal "drifts" segment
# never gets parsed as a variable id.
@router.get("/drifts", response_model=VariableValueDriftListResponse)
async def list_value_drifts(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID | None = None,
    event_id: uuid.UUID | None = None,
) -> VariableValueDriftListResponse:
    return await variable_value_drift_service.list_value_drifts(
        session, slug, variable_id, event_id
    )


# The one audited handler in this module with no ``BranchIdDep``, and
# deliberately so. Value drifts are only ever detected against main
# (event_generator resolves ``main_branch_id`` and passes it to
# ``detect_variable_value_drifts``), and ``apply_drift_action`` writes to
# ``variable.branch_id`` — main — whatever the request is scoped to. Declaring
# the dependency would bind the caller's branch and stamp the audit row with a
# branch the write never touched, which is the misattribution tripl-wkwv.6
# exists to end. No chip is the correct rendering here: the write is on main.
@router.post("/drifts/{drift_id}/action", response_model=VariableValueDriftResponse)
async def apply_value_drift_action(
    session: SessionDep,
    slug: str,
    drift_id: uuid.UUID,
    data: VariableValueDriftActionRequest,
    current_user: EditorUserDep,
) -> VariableValueDriftResponse:
    result = await variable_value_drift_service.apply_drift_action(
        session, slug, drift_id, data, current_user
    )
    await audit_service.record(
        session,
        user=current_user,
        action="variable.drift_action",
        target_type="variable",
        target_id=result.variable_id,
        target_name=result.variable_name,
        project_slug=slug,
        payload=data.model_dump(mode="json", exclude_none=True),
    )
    return result


@router.get("", response_model=VariableListResponse)
async def list_variables(
    session: SessionDep,
    slug: str,
    branch_id: BranchIdDep,
    offset: int = Query(0, ge=0),
    # Ceiling sized above the largest known project's variable count so a
    # single-page fetch stays possible; the default keeps unaware clients off
    # the multi-hundred-KB payload.
    limit: int = Query(DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
    usage: Literal["all", "used", "unused"] = Query(
        "all",
        description=(
            "Narrow to the variables nothing refers to ('unused' — exactly the "
            "set the retirement sweep would take) or to their complement "
            "('used'). Declared as an enum rather than a free string so an "
            "unknown value is a 422 and not a 500 (tripl-57g0)."
        ),
    ),
) -> VariableListResponse:
    items, total = await variable_service.list_variables(
        session, slug, branch_id, offset=offset, limit=limit, usage=usage
    )
    return VariableListResponse(
        items=[VariableResponse.model_validate(item) for item in items],
        total=total,
    )


@router.post("", response_model=VariableResponse, status_code=201)
async def create_variable(
    session: SessionDep,
    slug: str,
    data: VariableCreate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> Variable:
    v = await variable_service.create_variable(session, slug, data, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.create",
        target_type="variable",
        target_id=v.id,
        target_name=v.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return v


@router.get("/{variable_id}/values", response_model=list[VariableValueContextResponse])
async def list_variable_values(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    branch_id: BranchIdDep,
) -> list[VariableValue]:
    return await variable_value_service.list_variable_values(session, slug, variable_id, branch_id)


@router.get("/{variable_id}/event-overrides", response_model=list[VariableEventOverrideResponse])
async def list_event_overrides(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    branch_id: BranchIdDep,
) -> list[VariableEventValueOverride]:
    return await variable_service.list_event_overrides(session, slug, variable_id, branch_id)


@router.put(
    "/{variable_id}/event-overrides/{event_id}",
    response_model=VariableEventOverrideResponse,
)
async def upsert_event_override(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    event_id: uuid.UUID,
    data: VariableEventOverrideUpsert,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> VariableEventValueOverride:
    override = await variable_service.upsert_event_override(
        session, slug, variable_id, event_id, data, branch_id
    )
    await audit_service.record(
        session,
        user=current_user,
        action="variable.override_set",
        target_type="variable",
        target_id=variable_id,
        target_name=override.event_name,
        project_slug=slug,
        payload={"event_id": str(event_id), "values": data.values},
    )
    return override


@router.delete("/{variable_id}/event-overrides/{event_id}", status_code=204)
async def delete_event_override(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    event_id: uuid.UUID,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> None:
    await variable_service.delete_event_override(session, slug, variable_id, event_id, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.override_delete",
        target_type="variable",
        target_id=variable_id,
        project_slug=slug,
        payload={"event_id": str(event_id)},
    )


@router.patch("/{variable_id}", response_model=VariableResponse)
async def update_variable(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    data: VariableUpdate,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> Variable:
    v = await variable_service.update_variable(session, slug, variable_id, data, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.update",
        target_type="variable",
        target_id=v.id,
        target_name=v.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return v


@router.delete("/{variable_id}", status_code=204)
async def delete_variable(
    session: SessionDep,
    slug: str,
    variable_id: uuid.UUID,
    current_user: EditorUserDep,
    branch_id: BranchIdDep,
) -> None:
    # The service does the branch-scoped indexed lookup, raises the 404 when the
    # variable is missing, and hands back the name for the audit record.
    name = await variable_service.delete_variable(session, slug, variable_id, branch_id)
    await audit_service.record(
        session,
        user=current_user,
        action="variable.delete",
        target_type="variable",
        target_id=variable_id,
        target_name=name,
        project_slug=slug,
    )
