import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from tripl.models.domain_enums import SchemaDriftStatus

VariableValueDriftAction = Literal["accept", "snooze", "false_positive", "reopen"]
VariableValueDriftAcceptScope = Literal["global", "event"]


class VariableValueDriftResponse(BaseModel):
    id: uuid.UUID
    variable_id: uuid.UUID
    variable_name: str
    event_id: uuid.UUID
    event_name: str
    scan_config_id: uuid.UUID | None
    observed_values: list[str] = []
    status: SchemaDriftStatus = SchemaDriftStatus.open
    resolution_note: str | None = None
    snoozed_until: datetime | None = None
    resolved_at: datetime | None = None
    resolved_by: uuid.UUID | None = None
    detected_at: datetime

    model_config = {"from_attributes": True}


class VariableValueDriftListResponse(BaseModel):
    items: list[VariableValueDriftResponse]
    total: int


class VariableValueDriftActionRequest(BaseModel):
    action: VariableValueDriftAction
    # accept only: "global" appends the novel values to the variable's
    # allowed_values; "event" appends to (or creates) the per-event override,
    # seeded from the currently effective documented list.
    scope: VariableValueDriftAcceptScope = "global"
    note: str | None = Field(None, max_length=2000)
    snoozed_until: datetime | None = None

    @model_validator(mode="after")
    def validate_action(self) -> VariableValueDriftActionRequest:
        if self.action == "snooze" and self.snoozed_until is None:
            raise ValueError("snoozed_until is required when action is snooze")
        return self
