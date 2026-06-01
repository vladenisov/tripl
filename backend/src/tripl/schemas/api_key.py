from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ApiKeyScope = Literal["read", "write"]


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    scope: ApiKeyScope = "read"
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)
    # Bind the key to a single project. Omit (null) for a cross-project key.
    project_slug: str | None = Field(default=None, min_length=1, max_length=255)


class ApiKeyResponse(BaseModel):
    id: uuid.UUID
    name: str
    key_prefix: str
    scope: ApiKeyScope
    project_id: uuid.UUID | None
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ApiKeyCreateResponse(ApiKeyResponse):
    """Returned only once at creation — embeds the raw token operators must
    copy immediately."""

    token: str
