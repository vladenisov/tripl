from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field

SearchEntityType = Literal[
    "event",
    "event_type",
    "field",
    "meta_field",
    "variable",
    "relation",
    "tag",
]


class SearchResult(BaseModel):
    id: uuid.UUID
    entity_type: SearchEntityType
    entity_id: uuid.UUID
    parent_event_id: uuid.UUID | None = None
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
