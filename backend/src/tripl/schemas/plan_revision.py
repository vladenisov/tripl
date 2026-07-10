from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class PlanRevisionCreate(BaseModel):
    summary: str = Field(default="", max_length=2000)


class PlanRevisionSummary(BaseModel):
    """List-view of a revision — payload omitted to keep responses small."""

    id: uuid.UUID
    project_id: uuid.UUID
    summary: str
    created_at: datetime
    created_by: uuid.UUID | None
    # Coarse counts so the list UI can show "1 event type, 23 events, …" at a glance.
    entity_counts: dict[str, int]


class PlanRevisionDetail(PlanRevisionSummary):
    payload: dict[str, object]


class PlanRevisionList(BaseModel):
    items: list[PlanRevisionSummary]
    total: int


DriftKind = Literal["added", "removed", "changed"]


class PlanFieldChange(BaseModel):
    """A single field that changed between the base and branch state.

    ``before``/``after`` carry the raw JSON values (not repr strings) so the UI
    can render structured values — arrays, override maps — instead of a Python
    ``repr``. Only present on ``changed`` entries.
    """

    field: str
    before: Any = None
    after: Any = None


class PlanDiffEntry(BaseModel):
    entity_type: Literal[
        "event_type",
        "field_definition",
        "event",
        "variable",
        "meta_field",
        "relation",
    ]
    kind: DriftKind
    name: str
    parent: str | None = None
    # For changed entries: list of human-readable field-level changes,
    # e.g. ["field_type: string → number", "is_required: false → true"].
    changes: list[str] = Field(default_factory=list)
    # Structured mirror of ``changes`` for changed entries: raw before/after
    # values per field so the UI can render a proper diff table.
    field_changes: list[PlanFieldChange] = Field(default_factory=list)
    # Full entity state on each side, with DB ids / ordering / nested child
    # collections stripped. ``before`` is null for added entries, ``after`` is
    # null for removed entries; both are populated for changed entries.
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None


class PlanDiff(BaseModel):
    revision_id: uuid.UUID
    compare_to: uuid.UUID
    entries: list[PlanDiffEntry]
    summary: dict[str, int]
