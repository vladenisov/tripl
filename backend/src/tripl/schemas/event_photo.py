from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class EventPhotoResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    project_id: uuid.UUID
    original_filename: str
    content_type: str
    size_bytes: int
    storage_backend: str
    sort_order: int
    # Resolved URL the client can render directly. For "local" this is an
    # authenticated API endpoint; for "gcs" it's a signed URL (or public URL
    # when the bucket is configured public).
    url: str
    uploaded_by_user_id: uuid.UUID | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class EventPhotoReorder(BaseModel):
    photo_ids: list[uuid.UUID]
