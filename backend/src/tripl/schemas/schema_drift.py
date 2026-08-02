import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from tripl.models.domain_enums import SchemaDriftStatus, SchemaDriftType

SchemaDriftAction = Literal["accept", "snooze", "false_positive", "reopen"]


class SchemaDriftResponse(BaseModel):
    id: uuid.UUID
    event_type_id: uuid.UUID
    scan_config_id: uuid.UUID | None
    field_name: str
    drift_type: SchemaDriftType
    observed_type: str | None
    declared_type: str | None
    sample_value: str | None
    status: SchemaDriftStatus = SchemaDriftStatus.open
    resolution_note: str | None = None
    snoozed_until: datetime | None = None
    resolved_at: datetime | None = None
    resolved_by: uuid.UUID | None = None
    detected_at: datetime

    model_config = {"from_attributes": True}


class SchemaDriftListResponse(BaseModel):
    items: list[SchemaDriftResponse]
    total: int


class SchemaDriftActionRequest(BaseModel):
    action: SchemaDriftAction
    note: str | None = Field(None, max_length=2000)
    snoozed_until: datetime | None = None
    force: bool = Field(
        False,
        description=(
            "Override the guard that refuses to accept a missing_field drift for a "
            "column a scan config's event name format builds event names from "
            "(tripl-3mmh). API-only escape hatch for a project-wide config that "
            "names the column but never scans this event type; requires a note "
            "explaining why, which lands in the audit record. The UI does not "
            "offer it — a warning next to an Accept button is a thing operators "
            "click past, and clicking past it is what caused the outage."
        ),
    )

    @model_validator(mode="after")
    def validate_action(self) -> SchemaDriftActionRequest:
        if self.action == "snooze" and self.snoozed_until is None:
            raise ValueError("snoozed_until is required when action is snooze")
        if self.force and self.action != "accept":
            # `force` overrides exactly one guard, and that guard only fires on
            # the accept path. Accepting it elsewhere would make the contract
            # looser than the thing it overrides, and would silently swallow a
            # client that sent it by mistake — on a field whose whole purpose is
            # to be hard to reach by accident.
            raise ValueError("force is only meaningful when action is accept")
        if self.force and not (self.note or "").strip():
            raise ValueError("note is required when force is set")
        return self
