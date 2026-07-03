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


class DetectionResetPeriod(BaseModel):
    """Optional half-open window (``after <= t < before``) for a danger-zone reset.

    Both bounds are optional; omitting both clears the whole project.
    """

    before: datetime | None = None
    after: datetime | None = None


class AnomalyResetCounts(BaseModel):
    metric_anomalies: int
    metric_breakdown_anomalies: int


class DriftResetCounts(BaseModel):
    schema_drifts: int
    distribution_drifts: int


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
    actual_count: float
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
