from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class EventPhotoResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    project_id: uuid.UUID
    kind: str
    original_filename: str
    content_type: str
    size_bytes: int
    storage_backend: str | None
    sort_order: int
    # Resolved URL the client can render directly. For "local" this is an
    # authenticated API endpoint; for "gcs" it's a signed URL (or public URL
    # when the bucket is configured public). For figma-kind attachments this
    # is the embed URL.
    url: str
    external_url: str | None = None
    uploaded_by_user_id: uuid.UUID | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class EventPhotoReorder(BaseModel):
    photo_ids: list[uuid.UUID]


class EventPhotoFigmaCreate(BaseModel):
    """Attach a Figma frame/file as a design spec on this event."""

    url: str = Field(min_length=1, max_length=2000)
    title: str = Field(default="", max_length=500)


class EventPhotoCommentResponse(BaseModel):
    id: uuid.UUID
    photo_id: uuid.UUID
    parent_id: uuid.UUID | None
    user_id: uuid.UUID | None
    body: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EventPhotoCommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    parent_id: uuid.UUID | None = None
