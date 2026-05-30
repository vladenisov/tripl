from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, model_validator

# Project-wide markers leave both fields NULL; scoped markers must pair a
# scope_type with a scope_ref so chart filters never silently match the wrong
# series.
ALLOWED_SCOPES = {"project_total", "event_type", "event"}


class ChartAnnotationCreate(BaseModel):
    bucket: datetime
    label: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    color: str = Field(default="#ef4444", max_length=20)
    scope_type: str | None = Field(default=None, max_length=30)
    scope_ref: str | None = Field(default=None, max_length=120)

    @model_validator(mode="after")
    def validate_scope(self) -> ChartAnnotationCreate:
        if self.scope_type is None and self.scope_ref is None:
            return self
        if self.scope_type is None or self.scope_ref is None:
            raise ValueError(
                "scope_type and scope_ref must both be provided or both be null"
            )
        if self.scope_type not in ALLOWED_SCOPES:
            raise ValueError(
                f"scope_type must be one of {sorted(ALLOWED_SCOPES)}"
            )
        return self


class ChartAnnotationResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    scope_type: str | None
    scope_ref: str | None
    bucket: datetime
    label: str
    description: str | None
    color: str
    created_by_user_id: uuid.UUID | None
    created_at: datetime

    model_config = {"from_attributes": True}
