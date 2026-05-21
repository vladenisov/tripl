from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ChartAnnotationCreate(BaseModel):
    bucket: datetime
    label: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    color: str = Field(default="#ef4444", max_length=20)
    scope_type: str | None = Field(default=None, max_length=30)
    scope_ref: str | None = Field(default=None, max_length=120)


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
