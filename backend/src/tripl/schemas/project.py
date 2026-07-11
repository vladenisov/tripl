import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from tripl.models.domain_enums import (
    AnomalyDirection,
    MetricScopeType,
    ProjectGenerationStatus,
)
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
    # Number of scan configs whose *latest* run failed. Distinct from
    # ``latest_scan_job`` (the single newest job across the whole project): a
    # config that fails every run is invisible there once a *different* config
    # logs a newer success, so this per-config rollup is what the workspace
    # "failed jobs" surface must count.
    failing_scan_config_count: int = 0
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
    # Demo identity & provisioning state (real projects: is_demo=False,
    # generation_status="ready", the rest null). Surfaces provisioning progress
    # and failure detail to the UI without leaking internals.
    is_demo: bool = False
    generation_status: ProjectGenerationStatus = ProjectGenerationStatus.ready
    generation_stage: str | None = None
    generation_error: str | None = None
    demo_recipe_version: str | None = None
    demo_seeded_at: datetime | None = None
    created_by_user_id: uuid.UUID | None = None
    # Legacy-demo classification (tripl-2su6.10). ``demo_legacy`` marks a project
    # created by the PRE-epic demo path — is_demo=False but wired to a legacy
    # "Demo warehouse" clickhouse source at host demo.internal — so the UI can
    # show it as a static/upgradable demo. ``demo_outdated`` marks a first-class
    # demo (is_demo=True) seeded by an older recipe than the current one. Both
    # default False (a real project and a current demo are neither); the UI offers
    # an in-place upgrade when either is true.
    demo_legacy: bool = False
    demo_outdated: bool = False

    model_config = {"from_attributes": True}
