import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from tripl.models.domain_enums import AnomalyDirection, MetricScopeType
from tripl.models.scan_job import ScanJobStatus


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    slug: str = Field(min_length=1, max_length=255, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    slug: str | None = Field(
        None, min_length=1, max_length=255, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
    )
    description: str | None = None


class ProjectLatestScanJob(BaseModel):
    id: uuid.UUID
    scan_config_id: uuid.UUID
    scan_name: str
    status: ScanJobStatus
    started_at: datetime | None
    completed_at: datetime | None
    result_summary: dict[str, object] | None
    error_message: str | None
    created_at: datetime


class ProjectLatestSignal(BaseModel):
    scan_config_id: uuid.UUID
    scan_name: str
    scope_type: MetricScopeType
    scope_ref: str
    scope_name: str
    state: str
    bucket: datetime
    actual_count: int
    expected_count: float
    z_score: float
    direction: AnomalyDirection


class ProjectSummary(BaseModel):
    event_type_count: int = 0
    event_count: int = 0
    active_event_count: int = 0
    implemented_event_count: int = 0
    review_pending_event_count: int = 0
    archived_event_count: int = 0
    variable_count: int = 0
    scan_count: int = 0
    alert_destination_count: int = 0
    monitoring_signal_count: int = 0
    firing_monitor_count: int = 0
    latest_scan_job: ProjectLatestScanJob | None = None
    latest_signal: ProjectLatestSignal | None = None


class ProjectResponse(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    description: str
    created_at: datetime
    updated_at: datetime
    summary: ProjectSummary = Field(default_factory=ProjectSummary)

    model_config = {"from_attributes": True}
