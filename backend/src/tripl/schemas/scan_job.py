import uuid
from datetime import datetime

from pydantic import BaseModel


class ScanJobResponse(BaseModel):
    id: uuid.UUID
    scan_config_id: uuid.UUID
    status: str
    started_at: datetime | None
    completed_at: datetime | None
    result_summary: dict[str, object] | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ScanPreviewJobResponse(BaseModel):
    id: uuid.UUID
    status: str
    started_at: datetime | None
    completed_at: datetime | None
    # When status == "completed", holds the ScanConfigPreviewResponse payload
    # (columns / rows / json_columns); null while pending/running or on failure.
    result_summary: dict[str, object] | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
