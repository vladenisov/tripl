import uuid
from datetime import datetime

from pydantic import BaseModel


class ProjectTrackerConfigUpdate(BaseModel):
    """Partial update — every field optional. ``api_token`` is the RAW token on
    input; it is encrypted at rest and never echoed back. Passing ``""`` clears
    the stored token; omitting / null leaves it unchanged."""

    enabled: bool | None = None
    tracker_type: str | None = None
    base_url: str | None = None
    project_key: str | None = None
    auth_email: str | None = None
    api_token: str | None = None
    issue_type: str | None = None


class ProjectTrackerConfigResponse(BaseModel):
    """``id``/timestamps are None while the project rides the defaults — the row
    is only materialized on the first PATCH. The token is never returned; only
    ``api_token_set`` signals whether one is stored."""

    id: uuid.UUID | None = None
    project_id: uuid.UUID
    enabled: bool
    tracker_type: str
    base_url: str
    project_key: str
    auth_email: str
    issue_type: str
    api_token_set: bool
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}
