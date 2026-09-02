import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from tripl.models.event import EventStatus
from tripl.models.variable_value import VariableValueKind
from tripl.schemas.event_type import EventTypeBrief


class EventFieldValueIn(BaseModel):
    field_definition_id: uuid.UUID
    value: str = Field(max_length=100_000)


class EventMetaValueIn(BaseModel):
    meta_field_definition_id: uuid.UUID
    value: str


class EventCreate(BaseModel):
    event_type_id: uuid.UUID
    name: str = Field(min_length=1, max_length=500)
    description: str = ""
    status: EventStatus = EventStatus.draft
    sunset_at: datetime | None = None
    owner_id: uuid.UUID | None = None
    reviewed: bool = False
    metric_breakdown_columns: list[str] = []
    tags: list[str] = []
    field_values: list[EventFieldValueIn] = []
    meta_values: list[EventMetaValueIn] = []

    @field_validator("metric_breakdown_columns")
    @classmethod
    def validate_metric_breakdown_columns(cls, value: list[str]) -> list[str]:
        return _normalize_metric_breakdown_columns(value)


class EventUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=500)
    description: str | None = None
    status: EventStatus | None = None
    sunset_at: datetime | None = None
    owner_id: uuid.UUID | None = None
    reviewed: bool | None = None
    metric_breakdown_columns: list[str] | None = None
    tags: list[str] | None = None
    field_values: list[EventFieldValueIn] | None = None
    meta_values: list[EventMetaValueIn] | None = None

    @field_validator("metric_breakdown_columns")
    @classmethod
    def validate_metric_breakdown_columns(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_metric_breakdown_columns(value)


def _normalize_metric_breakdown_columns(value: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for item in value:
        column = item.strip()
        if not column:
            continue
        if "." in column:
            raise ValueError("metric_breakdown_columns supports scalar columns only")
        if column not in seen:
            normalized.append(column)
            seen.add(column)
    return normalized


class EventBulkDelete(BaseModel):
    event_ids: list[uuid.UUID] = Field(min_length=1)


class EventBulkUpdate(BaseModel):
    event_ids: list[uuid.UUID] = Field(min_length=1)
    status: EventStatus | None = None
    sunset_at: datetime | None = None
    owner_id: uuid.UUID | None = None
    reviewed: bool | None = None

    @model_validator(mode="after")
    def validate_has_update(self) -> EventBulkUpdate:
        if (
            self.status is None
            and self.sunset_at is None
            and self.owner_id is None
            and self.reviewed is None
        ):
            raise ValueError(
                "At least one of status, sunset_at, owner_id or reviewed must be provided"
            )
        return self


class EventMove(BaseModel):
    direction: Literal["up", "down"]
    visible_event_ids: list[uuid.UUID] | None = None


class EventReorder(BaseModel):
    event_ids: list[uuid.UUID] = Field(min_length=1)


class EventFieldVariableValueResponse(BaseModel):
    id: uuid.UUID
    variable_id: uuid.UUID
    variable_name: str
    source_column: str
    value_kind: VariableValueKind
    observed_count: int
    values: list[str] = []
    # Excluding a variable no longer deletes its contexts, so this row can now
    # outlive the scanning that produced it. The values below are then the last
    # ones seen and not a live reading, and the client has to be able to say
    # which it is holding: one rendering standing for two unrelated facts is the
    # defect tripl-xv77.4 fixed for the empty context, and a stale value shown as
    # current is the same mistake with more consequences.
    excluded_from_scans: bool = False

    model_config = {"from_attributes": True}


class EventFieldValueResponse(BaseModel):
    id: uuid.UUID
    field_definition_id: uuid.UUID
    value: str
    variable_values: list[EventFieldVariableValueResponse] = []

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


class EventChangeResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    user_id: uuid.UUID | None = None
    user_email: str | None = None
    field: str
    old_value: str | None = None
    new_value: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class EventResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    event_type_id: uuid.UUID
    event_type: EventTypeBrief
    name: str
    # The key a scan matches this event on, which is NOT ``name``: renaming an
    # event deliberately leaves it alone so the next scan does not recreate the
    # renamed event as a duplicate (core/analyzers/event_generator.py). It
    # decides whether an authored event merges with its scanned counterpart, and
    # until tripl-u2h9.10 it appeared in no response at all — so after creating
    # an event by hand there was no way to see which identity it had claimed, or
    # that a later rename had parted the two. NULL on an event no scan has seen
    # and no naming rule governed; the generator adopts ``name`` as the identity
    # the first time one does.
    source_name: str | None = None
    description: str
    order: int
    status: EventStatus
    sunset_at: datetime | None = None
    last_seen_at: datetime | None = None
    owner_id: uuid.UUID | None = None
    reviewed: bool = False
    metric_breakdown_columns: list[str] = []
    drift_count: int = 0
    tags: list[EventTagResponse] = []
    field_values: list[EventFieldValueResponse] = []
    meta_values: list[EventMetaValueResponse] = []
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EventMutationResponse(EventResponse):
    """Event returned after a create or update, with advisory template warnings."""

    warnings: list[str] = Field(default_factory=list)


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
    # Carried here as well as on ``EventResponse``: it is a plain column, so it
    # costs no extra query (unlike the ``event_type`` brief this variant drops),
    # and a client deciding whether an identity is free has to test the same
    # predicate the server does — ``source_name``, falling back to ``name`` only
    # where ``source_name`` is NULL. Comparing names alone silently misses a
    # scanned event that has since been renamed.
    source_name: str | None = None
    description: str
    order: int
    status: EventStatus
    sunset_at: datetime | None = None
    last_seen_at: datetime | None = None
    owner_id: uuid.UUID | None = None
    reviewed: bool = False
    metric_breakdown_columns: list[str] = []
    drift_count: int = 0
    # Alert-rule coverage: True when at least one enabled rule watches this event.
    # Populated by list_events; distinct from a live firing signal.
    monitored: bool = False
    tags: list[EventTagResponse] = []
    field_values: list[EventFieldValueResponse] = []
    meta_values: list[EventMetaValueResponse] = []
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EventListResponse(BaseModel):
    items: list[EventListItemResponse]
    total: int
