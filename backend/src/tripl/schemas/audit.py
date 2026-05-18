from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel


class AuditEntryResponse(BaseModel):
    id: uuid.UUID
    created_at: datetime
    user_id: uuid.UUID | None
    user_email: str
    project_id: uuid.UUID | None
    project_slug: str
    action: str
    target_type: str
    target_id: uuid.UUID | None
    target_name: str
    payload: dict[str, Any]

    model_config = {"from_attributes": True}


class AuditListResponse(BaseModel):
    items: list[AuditEntryResponse]
    total: int
