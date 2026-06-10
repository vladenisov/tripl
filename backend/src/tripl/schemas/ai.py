from __future__ import annotations

import uuid

from pydantic import BaseModel, Field


class AiStatusResponse(BaseModel):
    enabled: bool


class AiDescribeEventRequest(BaseModel):
    event_id: uuid.UUID


class AiDescribeEventTypeRequest(BaseModel):
    event_type_id: uuid.UUID


class AiFieldSuggestion(BaseModel):
    field_name: str
    description: str


class AiDescribeResponse(BaseModel):
    description: str
    field_suggestions: list[AiFieldSuggestion]


class AiAskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=500)


class AiAskSource(BaseModel):
    title: str
    entity_type: str
    route_path: str


class AiAskResponse(BaseModel):
    answer: str
    sources: list[AiAskSource]
    semantic_used: bool
