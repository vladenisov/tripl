import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ProjectAnomalySettingsUpdate(BaseModel):
    anomaly_detection_enabled: bool | None = None
    detect_project_total: bool | None = None
    detect_event_types: bool | None = None
    detect_events: bool | None = None
    detect_metrics: bool | None = None
    baseline_window_buckets: int | None = Field(None, ge=1)
    min_history_buckets: int | None = Field(None, ge=1)
    sigma_threshold: float | None = Field(None, ge=0.1)
    min_expected_count: int | None = Field(None, ge=0)


class ProjectAnomalySettingsResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    anomaly_detection_enabled: bool
    detect_project_total: bool
    detect_event_types: bool
    detect_events: bool
    detect_metrics: bool
    baseline_window_buckets: int
    min_history_buckets: int
    sigma_threshold: float
    min_expected_count: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
