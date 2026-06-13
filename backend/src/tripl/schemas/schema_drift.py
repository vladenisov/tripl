import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

SchemaDriftStatus = Literal["open", "accepted", "snoozed", "false_positive"]
SchemaDriftAction = Literal["accept", "snooze", "false_positive", "reopen"]


class SchemaDriftResponse(BaseModel):
    id: uuid.UUID
    event_type_id: uuid.UUID
    scan_config_id: uuid.UUID | None
    field_name: str
    drift_type: Literal[
        "new_field",
        "missing_field",
        "type_changed",
        "enum_violation",
        "required_null_violation",
        "regex_violation",
        "range_violation",
    ]
    observed_type: str | None
    declared_type: str | None
    sample_value: str | None
    status: SchemaDriftStatus = "open"
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

    @model_validator(mode="after")
    def validate_action(self) -> SchemaDriftActionRequest:
        if self.action == "snooze" and self.snoozed_until is None:
            raise ValueError("snoozed_until is required when action is snooze")
        return self
