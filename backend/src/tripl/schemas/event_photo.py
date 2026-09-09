from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from tripl.models.domain_enums import (
    EventCommentStatus,
    EventPhotoKind,
    EventPhotoStorageBackend,
)


class EventPhotoResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    project_id: uuid.UUID
    kind: EventPhotoKind
    original_filename: str
    content_type: str
    size_bytes: int
    storage_backend: EventPhotoStorageBackend | None
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
    # Exactly one anchor is set, enforced by ck_event_photo_comment_one_anchor:
    # a comment pinned to one attachment, or the event's own discussion.
    photo_id: uuid.UUID | None = None
    event_id: uuid.UUID | None = None
    parent_id: uuid.UUID | None
    user_id: uuid.UUID | None
    body: str
    # Resolution state. Carried on every row because this is one table, but only
    # a top-level comment can be acted on — the thread is what gets answered.
    status: EventCommentStatus = EventCommentStatus.open
    resolution_note: str | None = None
    snoozed_until: datetime | None = None
    resolved_at: datetime | None = None
    resolved_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


EventCommentAction = Literal["resolve", "snooze", "reopen"]


class EventPhotoCommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    parent_id: uuid.UUID | None = None


class EventCommentActionRequest(BaseModel):
    """One action on one thread, shaped like ``SchemaDriftActionRequest``.

    POST to an ``/actions`` sub-resource rather than PATCH on the comment, the
    way every other resolvable thing in this codebase does it: the body names an
    intent, and the five columns it moves are the service's business, not the
    client's.
    """

    action: EventCommentAction
    note: str | None = Field(None, max_length=2000)
    snoozed_until: datetime | None = None

    @model_validator(mode="after")
    def validate_action(self) -> EventCommentActionRequest:
        if self.action == "snooze" and self.snoozed_until is None:
            raise ValueError("snoozed_until is required when action is snooze")
        if self.action != "snooze" and self.snoozed_until is not None:
            # A snooze date on a resolve or a reopen is a client that meant
            # something else; accepting and discarding it would hide the mistake.
            raise ValueError("snoozed_until is only meaningful when action is snooze")
        return self
