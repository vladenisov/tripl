from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, field_validator


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
    kind: str
    status: str
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
