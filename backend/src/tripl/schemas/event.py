import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from tripl.schemas.event_type import EventTypeBrief


class EventFieldValueIn(BaseModel):
    field_definition_id: uuid.UUID
    value: str


class EventMetaValueIn(BaseModel):
    meta_field_definition_id: uuid.UUID
    value: str


class EventCreate(BaseModel):
    event_type_id: uuid.UUID
    name: str = Field(min_length=1, max_length=500)
    description: str = ""
    implemented: bool = False
    reviewed: bool = True
    archived: bool = False
    tags: list[str] = []
    field_values: list[EventFieldValueIn] = []
    meta_values: list[EventMetaValueIn] = []


class EventUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=500)
    description: str | None = None
    implemented: bool | None = None
    reviewed: bool | None = None
    archived: bool | None = None
    tags: list[str] | None = None
    field_values: list[EventFieldValueIn] | None = None
    meta_values: list[EventMetaValueIn] | None = None


class EventBulkDelete(BaseModel):
    event_ids: list[uuid.UUID] = Field(min_length=1)


class EventMove(BaseModel):
    direction: Literal["up", "down"]
    visible_event_ids: list[uuid.UUID] | None = None


class EventReorder(BaseModel):
    event_ids: list[uuid.UUID] = Field(min_length=1)


class EventFieldValueResponse(BaseModel):
    id: uuid.UUID
    field_definition_id: uuid.UUID
    value: str

    model_config = {"from_attributes": True}


class EventMetaValueResponse(BaseModel):
    id: uuid.UUID
    meta_field_definition_id: uuid.UUID
    value: str

    model_config = {"from_attributes": True}


class EventTagResponse(BaseModel):
    id: uuid.UUID
    name: str

    model_config = {"from_attributes": True}


class EventResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    event_type_id: uuid.UUID
    event_type: EventTypeBrief
    name: str
    description: str
    order: int
    implemented: bool
    reviewed: bool
    archived: bool
    last_seen_at: datetime | None = None
    tags: list[EventTagResponse] = []
    field_values: list[EventFieldValueResponse] = []
    meta_values: list[EventMetaValueResponse] = []
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EventListItemResponse(BaseModel):
    """Slim variant of EventResponse used by the list endpoint.

    Drops the nested ``event_type`` payload — the frontend already loads
    EventTypes separately and looks them up by id, so shipping the brief here
    is pure overhead at scale (and triggers an extra selectin SQL query).
    """

    id: uuid.UUID
    project_id: uuid.UUID
    event_type_id: uuid.UUID
    name: str
    description: str
    order: int
    implemented: bool
    reviewed: bool
    archived: bool
    last_seen_at: datetime | None = None
    tags: list[EventTagResponse] = []
    field_values: list[EventFieldValueResponse] = []
    meta_values: list[EventMetaValueResponse] = []
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EventListResponse(BaseModel):
    items: list[EventListItemResponse]
    total: int
