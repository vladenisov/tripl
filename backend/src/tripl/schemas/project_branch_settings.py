import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ProjectBranchSettingsUpdate(BaseModel):
    min_approvals: int | None = Field(None, ge=0, le=100)
    block_self_approval: bool | None = None


class ProjectBranchSettingsResponse(BaseModel):
    """``id``/timestamps are None while the project still rides the defaults —
    the settings row is only materialized on the first PATCH."""

    id: uuid.UUID | None = None
    project_id: uuid.UUID
    min_approvals: int
    block_self_approval: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}
