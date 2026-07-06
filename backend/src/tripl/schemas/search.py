from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field

from tripl.models.variable_value import VariableValueKind

SearchEntityType = Literal[
    "event",
    "event_type",
    "field",
    "meta_field",
    "variable",
    "relation",
    "tag",
    "metric",
    "fact_table",
]


class SearchEventVariableValue(BaseModel):
    id: uuid.UUID
    variable_id: uuid.UUID
    variable_name: str
    field_definition_id: uuid.UUID
    field_name: str
    field_display_name: str
    source_column: str
    value_kind: VariableValueKind
    observed_count: int
    values: list[str] = []


class SearchResult(BaseModel):
    id: uuid.UUID
    entity_type: SearchEntityType
    entity_id: uuid.UUID
    parent_event_id: uuid.UUID | None = None
    event_id: uuid.UUID | None = None
    name: str | None = None
    implemented: bool | None = None
    variable_values: list[SearchEventVariableValue] = []
    title: str
    subtitle: str = ""
    description: str = ""
    snippet: str = ""
    route_path: str
    score: float
    # Relevance normalized to the top result of this response, in [0, 1].
    # Surfaced in the UI as a percentage / colored badge.
    confidence: float = 0.0
    highlights: list[str] = []
    semantic_used: bool = False


class SearchResponse(BaseModel):
    items: list[SearchResult]
    total: int
    semantic_used: bool = False


class SearchReindexResponse(BaseModel):
    documents_indexed: int = Field(ge=0)
    embeddings_scheduled: bool = False
