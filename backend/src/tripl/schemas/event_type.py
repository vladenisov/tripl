import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from tripl.schemas.field_definition import FieldDefinitionCreate, FieldDefinitionResponse


class EventTypeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=255)
    description: str = ""
    color: str = Field(default="#6366f1", pattern=r"^#[0-9a-fA-F]{6}$")
    order: int = 0
    field_definitions: list[FieldDefinitionCreate] = Field(default_factory=list)


class EventTypeUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    color: str | None = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    order: int | None = None


class EventTypeResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    display_name: str
    description: str
    color: str
    order: int
    created_at: datetime
    updated_at: datetime
    field_definitions: list[FieldDefinitionResponse] = []

    model_config = {"from_attributes": True}


class EventTypeBrief(BaseModel):
    id: uuid.UUID
    name: str
    display_name: str
    color: str

    model_config = {"from_attributes": True}
