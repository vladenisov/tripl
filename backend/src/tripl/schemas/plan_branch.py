from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, field_validator

from tripl.models.domain_enums import MergeResolutionChoice
from tripl.models.plan_branch import BranchKind, BranchStatus
from tripl.schemas.plan_revision import PlanDiffEntry, PlanEntityType

BranchTransitionAction = Literal[
    "submit",
    "request_changes",
    "approve",
    "reopen",
    "close",
]


class PlanBranchCreate(BaseModel):
    name: str
    description: str = ""

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Branch name is required")
        if normalized.lower() == "main":
            raise ValueError("'main' is reserved for the live plan")
        return normalized


class PlanBranchResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    kind: BranchKind
    status: BranchStatus
    description: str
    base_revision_id: uuid.UUID | None
    created_by: uuid.UUID | None
    merged_at: datetime | None
    merged_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PlanBranchList(BaseModel):
    items: list[PlanBranchResponse]
    total: int


class BranchReviewerResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    created_at: datetime

    model_config = {"from_attributes": True}


class BranchApprovalResponse(BaseModel):
    user_id: uuid.UUID | None
    approved_at: datetime

    model_config = {"from_attributes": True}


class PlanBranchDetailResponse(PlanBranchResponse):
    reviewers: list[BranchReviewerResponse]
    approvals: list[BranchApprovalResponse]


class BranchTransitionRequest(BaseModel):
    action: BranchTransitionAction


class BranchReviewerCreate(BaseModel):
    user_id: uuid.UUID


class BranchCommentCreate(BaseModel):
    body: str
    parent_id: uuid.UUID | None = None

    @field_validator("body")
    @classmethod
    def validate_body(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Comment body is required")
        return normalized


class BranchCommentResponse(BaseModel):
    id: uuid.UUID
    branch_id: uuid.UUID
    parent_id: uuid.UUID | None
    user_id: uuid.UUID | None
    body: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PlanBranchDiff(BaseModel):
    entries: list[PlanDiffEntry]
    summary: dict[str, int]
    # True when main advanced since the branch's base snapshot — the branch is
    # behind and should be rebased before merge (Phase 4).
    behind_base: bool


class BranchRevertRequest(BaseModel):
    """Undo one entry of the branch's diff.

    The entry is addressed the way the diff names it — entity type, natural name
    and parent — rather than by id, so the request describes a *change* rather
    than a row. ``field`` narrows the revert to one changed field; omitted, the
    whole entity goes back to its base state.
    """

    entity_type: PlanEntityType
    name: str
    parent: str | None = None
    field: str | None = None


# --- inline 3-way merge conflict resolution ---------------------------------

ResolutionChoice = MergeResolutionChoice


class ConflictField(BaseModel):
    """A single field that diverged on both sides of the merge.

    ``base`` is the value when the branch was created; ``ours`` is main's
    current value; ``theirs`` is the branch's current value. The reviewer
    picks ``choice`` to drive the merge for this field; ``None`` means
    unresolved (merge stays blocked).
    """

    field: str
    base: Any | None
    ours: Any | None
    theirs: Any | None
    choice: ResolutionChoice | None = None


class ConflictEntity(BaseModel):
    entity_type: str
    name: str
    fields: list[ConflictField]


class BranchConflictsResponse(BaseModel):
    entities: list[ConflictEntity]
    unresolved_count: int


class ResolutionCreate(BaseModel):
    entity_type: str
    entity_name: str
    field_name: str
    choice: ResolutionChoice


class ResolutionResponse(BaseModel):
    id: uuid.UUID
    branch_id: uuid.UUID
    entity_type: str
    entity_name: str
    field_name: str
    choice: ResolutionChoice
    resolved_by: uuid.UUID | None
    created_at: datetime

    model_config = {"from_attributes": True}
