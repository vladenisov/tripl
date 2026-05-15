import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class SchemaDriftResponse(BaseModel):
    id: uuid.UUID
    event_type_id: uuid.UUID
    scan_config_id: uuid.UUID | None
    field_name: str
    drift_type: Literal["new_field", "missing_field", "type_changed"]
    observed_type: str | None
    declared_type: str | None
    sample_value: str | None
    detected_at: datetime

    model_config = {"from_attributes": True}


class SchemaDriftListResponse(BaseModel):
    items: list[SchemaDriftResponse]
    total: int
