import uuid
from datetime import datetime

from pydantic import BaseModel

from tripl.models.domain_enums import (
    AnomalyDirection,
    DistributionDriftBand,
    MetricScopeType,
    ReleaseComparabilityReason,
    ReleaseRegressionKind,
    ScanInterval,
)
from tripl.models.project_anomaly_settings import DEFAULT_SIGMA_THRESHOLD


class EventMetricPoint(BaseModel):
    bucket: datetime
    count: int
    expected_count: float | None = None
    # The FLOORED "effective" stddev actually used in the z denominator when the
    # bucket was flagged (tripl-dmch C3/C4) — served in place of the raw rolling
    # stddev so the UI band (expected ± sigma_threshold * stddev) lines up exactly
    # with the detector's decision: a flagged point sits outside the band. Only
    # populated for buckets with an anomaly row; for the rest the band is undrawn.
    # Falls back to the raw stored stddev when the effective column is absent.
    stddev: float | None = None
    # Which detector path flagged this bucket ("phase" | "rolling" | "trend" |
    # "fractional"); null on non-anomaly buckets. Advisory metadata for the UI.
    detector_kind: str | None = None
    is_anomaly: bool = False
    anomaly_direction: AnomalyDirection | None = None
    z_score: float | None = None


class PlatformParityAnomaly(BaseModel):
    bucket: datetime
    actual_share: float
    expected_share: float
    stddev: float
    z_score: float
    direction: AnomalyDirection


class MetricSignalResponse(BaseModel):
    # NULL for ``metric``-scope signals (catalog MetricDefinition series are
    # project-global and not tied to a single scan config).
    scan_config_id: uuid.UUID | None = None
    scope_type: MetricScopeType
    scope_ref: str
    state: str
    event_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    bucket: datetime
    actual_count: float
    expected_count: float
    stddev: float
    z_score: float
    direction: AnomalyDirection
    # Display name of the scope that fired — the event name, the event type's
    # display name, or the catalog metric's display name. Carried here so a
    # client can label the row from the signal alone: the AnomaliesPage used to
    # download the whole event catalog (2641 rows / 1.7s on windy-ios) purely to
    # build an id -> name map, and rendered "Spike on Event d4c684dd" until it
    # landed, while the activity rail called the same incident by its real name
    # (tripl-y4wt). NULL means the name could not be resolved — the entity was
    # deleted out from under the anomaly row, or the scope is ``project_total``,
    # which is named by the project, not by a lookup. Clients must not fall back
    # to ``scope_ref``: a hex prefix reads as a name.
    scope_name: str | None = None
    # True when this row is a child scope (event_type/event) folded under a
    # co-firing project_total incident on the same scan/bucket/direction. The
    # expanded AnomaliesPage keeps children visible but tags them; the default
    # (collapsed) list drops them entirely, so they never carry this flag there.
    incident_child: bool = False


class SeasonalityCell(BaseModel):
    """One cell of the 7×24 hour-of-day × weekday seasonality heatmap.

    `weekday` is ISO-style with Monday=0..Sunday=6 to match Python's
    `datetime.weekday()`. `count` is the total volume observed in that
    slot across the queried time range; `anomaly_count` is the number of
    detected anomalies whose bucket fell into the same slot.
    """

    weekday: int
    hour: int
    count: int
    anomaly_count: int


class SeasonalityHeatmapResponse(BaseModel):
    scan_config_id: uuid.UUID
    scope_type: MetricScopeType
    scope_ref: str
    cells: list[SeasonalityCell]
    max_count: int
    total_count: int
    #: The scan interval the cells were binned from, and whether that interval
    #: actually resolves an hour. A daily or weekly scan puts EVERY bucket in
    #: hour 0, so 23 of each row's 24 cells are structurally empty — a 7x24 grid
    #: then reads as missing data instead of as a coarser interval
    #: (tripl-jfm3.128). Clients render the weekday strip alone when this is
    #: false rather than drawing a grid that can never fill.
    interval: str
    hourly_resolution: bool


class BreakdownTimelinePoint(BaseModel):
    bucket: datetime
    count: int


class BreakdownTimelineResponse(BaseModel):
    scan_config_id: uuid.UUID
    scope_type: MetricScopeType
    scope_ref: str
    breakdown_column: str
    breakdown_value: str
    is_other: bool
    interval: ScanInterval | None
    data: list[BreakdownTimelinePoint]


class ForecastPoint(BaseModel):
    """One-step-ahead expected value emitted alongside the historical series.

    `bucket` is the timestamp of the bucket *being forecast* (i.e. one
    interval past the last actual point). `expected_count` and `stddev` come
    from the same STL/MSTL decomposition used for anomaly detection.
    """

    bucket: datetime
    expected_count: float
    stddev: float


class EventMetricsResponse(BaseModel):
    scope: str
    scan_config_id: uuid.UUID | None = None
    # Display name of the scan config the series is scoped to. The
    # project-total and events-total series chart ONE scan config (summing
    # every config double-counts events a legacy/backfill scan also collected),
    # so the UI must be able to name the scan instead of calling a 2.4 %-of-
    # project series "project total" (tripl-jfm3.20).
    scan_config_name: str | None = None
    event_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    interval: ScanInterval | None = None
    latest_signal: MetricSignalResponse | None = None
    # The scan's anomaly sigma threshold — the ``k`` the UI multiplies the
    # per-point (effective) stddev by to draw the confidence band, so "outside
    # the band" equals "flagged". Defaults to the scan-config default.
    sigma_threshold: float = DEFAULT_SIGMA_THRESHOLD
    data: list[EventMetricPoint]
    forecast: list[ForecastPoint] = []


class EventMetricBreakdownSeries(BaseModel):
    breakdown_value: str
    is_other: bool = False
    total_count: int
    data: list[EventMetricPoint]
    parity_anomalies: list[PlatformParityAnomaly] = []


class EventMetricBreakdownsResponse(BaseModel):
    event_id: uuid.UUID
    scan_config_id: uuid.UUID | None = None
    interval: ScanInterval | None = None
    columns: list[str]
    selected_column: str | None = None
    series: list[EventMetricBreakdownSeries]


class AppVersionInfo(BaseModel):
    version: str
    is_other: bool = False
    is_latest: bool = False
    # True once the release takes a real share of traffic (activation gate),
    # distinguishing an active release from a merely "newest seen" dev build.
    is_active: bool = False


class AppVersionMetricSeries(BaseModel):
    version: str
    is_other: bool = False
    is_latest: bool = False
    is_active: bool = False
    total_count: int
    data: list[EventMetricPoint]


class AppVersionSeriesResponse(BaseModel):
    scan_config_id: uuid.UUID
    scope_type: MetricScopeType
    scope_ref: str
    event_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    app_version_column: str | None = None
    interval: ScanInterval | None = None
    latest_version: str | None = None
    # See EventMetricsResponse.sigma_threshold — the confidence-band multiplier.
    sigma_threshold: float = DEFAULT_SIGMA_THRESHOLD
    versions: list[AppVersionInfo]
    series: list[AppVersionMetricSeries]


class AppVersionAdoptionResponse(AppVersionSeriesResponse):
    totals: list[BreakdownTimelinePoint]


class ReleaseRegressionItem(BaseModel):
    """One event (or event type) that regressed in the latest active release."""

    scope_type: MetricScopeType
    scope_ref: str
    scope_name: str
    event_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    kind: ReleaseRegressionKind
    version: str
    previous_version: str
    observed_count: int
    expected_count: float
    ratio: float
    share_prev: float
    share_new: float
    release_share: float
    window_from: datetime
    window_to: datetime


class ReleaseComparabilityItem(BaseModel):
    """Whether one detection pass could judge the latest release at all.

    Served alongside ``items`` because an empty list means two different things.
    A caller that only reads ``items`` cannot tell a healthy release from one
    whose findings were withheld, and both were served as an empty list until
    this was carried through.
    """

    scope_type: MetricScopeType
    comparable: bool
    reason: ReleaseComparabilityReason
    version: str | None = None
    previous_version: str | None = None
    emerging_share: float
    max_emerging_share: float


class ReleaseRegressionsResponse(BaseModel):
    scan_config_id: uuid.UUID
    app_version_column: str | None = None
    latest_version: str | None = None
    # One entry per scope the scan evaluated (filtered by the ``scope_type``
    # query parameter when one is given). Empty means no pass has run.
    comparability: list[ReleaseComparabilityItem]
    items: list[ReleaseRegressionItem]


class PlatformPresenceRow(BaseModel):
    """One event and the platform values it has stored breakdown data for."""

    event_id: uuid.UUID
    event_name: str
    present_platforms: list[str]


class PlatformPresenceResponse(BaseModel):
    """Per-event platform presence matrix derived from EventMetricBreakdown rows
    on the scan's designated ``platform_column``. Empty when the column is unset."""

    scan_config_id: uuid.UUID
    platform_column: str | None = None
    platforms: list[str]
    items: list[PlatformPresenceRow]


class TopMoverItem(BaseModel):
    """One row of "what moved this anomaly" — backed by MetricBreakdownAnomaly."""

    breakdown_column: str
    breakdown_value: str
    is_other: bool
    actual_count: float
    expected_count: float
    stddev: float
    z_score: float
    direction: AnomalyDirection


class DistributionDriftTopMover(BaseModel):
    value: str
    baseline_share: float
    current_share: float
    contribution: float


class DistributionDriftPoint(BaseModel):
    id: uuid.UUID
    scan_config_id: uuid.UUID
    event_type_id: uuid.UUID | None = None
    field_name: str
    bucket: datetime
    psi: float
    band: DistributionDriftBand
    baseline_total: int
    current_total: int
    top_movers: list[DistributionDriftTopMover]


class DistributionDriftsResponse(BaseModel):
    scope: str
    scan_config_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    fields: list[str]
    data: list[DistributionDriftPoint]


class EventWindowMetricsRequest(BaseModel):
    event_ids: list[uuid.UUID]
    time_from: datetime | None = None
    time_to: datetime | None = None


class ActiveSignalsQuery(BaseModel):
    event_ids: list[uuid.UUID] = []


class EventWindowMetricsResponse(BaseModel):
    event_id: uuid.UUID
    scan_config_id: uuid.UUID | None = None
    interval: ScanInterval | None = None
    total_count: int
    data: list[EventMetricPoint]


class TopEventResponse(BaseModel):
    """One row of the Overview "Top events by volume" widget."""

    event_id: uuid.UUID
    name: str
    event_type_id: uuid.UUID
    total_count: int


class OverviewKpiSeriesResponse(BaseModel):
    """Real daily series behind Overview KPI sparklines.

    Only ``new_events`` (events created per day on the main branch, from
    Event.created_at) has genuine history; other KPIs (active events, open
    signals, review-pending) have no time series until snapshotting is added,
    so they are intentionally omitted rather than fabricated. The field was
    named ``active_events`` until tripl-jfm3.22 — it never held active-event
    counts, and the Overview sparkline repeated that false claim in its label.
    """

    days: int
    new_events: list[int]
