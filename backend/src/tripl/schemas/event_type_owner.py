from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class EventTypeOwnerCreate(BaseModel):
    user_id: uuid.UUID


class EventTypeOwnerResponse(BaseModel):
    id: uuid.UUID
    event_type_id: uuid.UUID
    user_id: uuid.UUID
    user_email: str
    user_name: str
    granted_by: uuid.UUID | None
    created_at: datetime

    model_config = {"from_attributes": True}
