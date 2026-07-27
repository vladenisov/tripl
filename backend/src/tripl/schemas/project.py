import uuid
from datetime import datetime
from typing import cast

from pydantic import BaseModel, Field

from tripl.models.domain_enums import (
    AnomalyDirection,
    MetricScopeType,
    ProjectGenerationStatus,
)
from tripl.models.scan_job import ScanJobStatus
from tripl.semver import (
    DEFAULT_APP_VERSION_KEEP_RELEASES,
    MAX_APP_VERSION_KEEP_RELEASES,
)


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    slug: str = Field(min_length=1, max_length=255, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    description: str = ""
    app_version_keep_releases: int = Field(
        default=DEFAULT_APP_VERSION_KEEP_RELEASES,
        ge=1,
        le=MAX_APP_VERSION_KEEP_RELEASES,
    )


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    slug: str | None = Field(
        None, min_length=1, max_length=255, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
    )
    description: str | None = None
    # ``int`` with a default of None makes the PATCH field optional while still
    # rejecting an explicitly supplied JSON null (and keeps OpenAPI non-nullable).
    app_version_keep_releases: int = Field(
        cast(int, None),
        ge=1,
        le=MAX_APP_VERSION_KEEP_RELEASES,
    )


class DetectionResetPeriod(BaseModel):
    """Optional half-open window (``after <= t < before``) for a danger-zone reset.

    Both bounds are optional; omitting both clears the whole project.
    """

    before: datetime | None = None
    after: datetime | None = None


class DemoCancelResponse(BaseModel):
    """Outcome of asking an in-flight demo provision to abandon itself.

    ``cancelled`` is only true when a still-seeding shell was found and flagged;
    the provision then deletes itself instead of promoting. When it is false the
    create had already finished (or never started), so the caller must be told
    plainly that the demo will appear rather than pretending it was stopped.
    """

    cancelled: bool
    slug: str | None = None


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
    # ENABLED alert rules across this project's destinations. A destination on
    # its own routes nothing — a rule is what binds a signal to a channel — so
    # "is alerting actually wired up?" needs both counters, not just the
    # destination one (tripl-jfm3.81). Disabled rules are excluded because they
    # deliver nothing either.
    alert_rule_count: int = 0
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
    app_version_keep_releases: int = Field(
        default=DEFAULT_APP_VERSION_KEEP_RELEASES,
        ge=1,
        le=MAX_APP_VERSION_KEEP_RELEASES,
    )
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
    # When the demo was seeded. Floored to the hour, because the runtime tick
    # anchors its bucket grid to it — so it is NOT a usable "freshness" stamp:
    # a demo seeded at 10:59 carries 10:00. Use demo_last_tick_at for that.
    demo_seeded_at: datetime | None = None
    # When the runtime tick last advanced this demo's data. NULL until the first
    # tick. This is the only honest freshness signal the UI has (tripl-2su6.17).
    demo_last_tick_at: datetime | None = None
    created_by_user_id: uuid.UUID | None = None

    model_config = {"from_attributes": True}
