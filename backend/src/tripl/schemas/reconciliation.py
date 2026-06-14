from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from tripl.models.domain_enums import ShadowEventStatus


class ShadowEventCandidateResponse(BaseModel):
    id: uuid.UUID
    scan_config_id: uuid.UUID
    scan_config_name: str
    event_type_id: uuid.UUID | None
    event_type_name: str | None
    event_name: str
    observed_count: int
    first_seen_at: datetime
    last_seen_at: datetime
    status: ShadowEventStatus
    accepted_event_id: uuid.UUID | None


class ShadowEventListResponse(BaseModel):
    items: list[ShadowEventCandidateResponse]
    total: int
    new_count: int


class ShadowEventAcceptRequest(BaseModel):
    # Defaults to the candidate's detected event type / observed identity.
    event_type_id: uuid.UUID | None = None
    name: str | None = Field(None, min_length=1, max_length=500)


class ShadowEventAcceptResponse(BaseModel):
    candidate_id: uuid.UUID
    event_id: uuid.UUID
    status: ShadowEventStatus


class ShadowEventDismissResponse(BaseModel):
    candidate_id: uuid.UUID
    status: ShadowEventStatus


class DeadEventItem(BaseModel):
    event_id: uuid.UUID
    name: str
    event_type_id: uuid.UUID
    event_type_name: str
    last_seen_at: datetime | None
    created_at: datetime


class DeadEventListResponse(BaseModel):
    items: list[DeadEventItem]
    total: int
    days: int


class CoverageBucket(BaseModel):
    bucket: datetime
    total_count: int
    matched_count: int


class CoverageSummary(BaseModel):
    total_count: int
    matched_count: int
    coverage_pct: float


class CoverageResponse(BaseModel):
    items: list[CoverageBucket]
    summary: CoverageSummary
    days: int
