from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field, PrivateAttr

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
    # How certain this result is, in [0, 1] — an ABSOLUTE property of the
    # result, NOT a fraction of the top hit of this response (tripl-txcz).
    # Surfaced in the UI as a percentage / colored badge, so it has to mean the
    # same thing across two different searches: a query that matched nothing
    # well comes back low instead of being 1.0 by construction.
    # ``_search_query.finalize_results`` computes it; see that docstring for the
    # two certainties it is the maximum of (the absolute score ladder, and — for
    # a result the semantic leg produced — that leg's cosine similarity).
    confidence: float = 0.0
    highlights: list[str] = []
    semantic_used: bool = False

    # Cosine similarity of the semantic leg for this result in [0, 1], or None
    # when that leg did not contribute to it.
    #
    # PRIVATE, and deliberately NOT a response field (tripl-txcz): it exists
    # only so ``finalize_results`` can express a semantic hit's certainty on the
    # same 0-1 scale as a lexical one. The merged ``score`` cannot carry that
    # information, because a vector-only hit is scored ``cosine * 2.5`` for
    # RANKING — read confidence off the score alone and a PERFECT cosine is
    # reported as 2.5 / 7.0 = 0.357, i.e. a semantic rescue served as
    # barely-a-guess. Keeping it off the wire means no new field for API clients
    # or the frontend TS types to track.
    _semantic_cosine: float | None = PrivateAttr(default=None)

    @property
    def semantic_cosine(self) -> float | None:
        """The semantic leg's cosine for this result, or ``None``."""
        return self._semantic_cosine

    def record_semantic_cosine(self, cosine: float) -> None:
        """Remember the semantic leg's cosine, clamped into [0, 1]."""
        self._semantic_cosine = max(0.0, min(1.0, cosine))


class SearchResponse(BaseModel):
    items: list[SearchResult]
    total: int
    semantic_used: bool = False


class SearchReindexResponse(BaseModel):
    documents_indexed: int = Field(ge=0)
    embeddings_scheduled: bool = False
