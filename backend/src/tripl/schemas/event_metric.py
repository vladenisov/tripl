import uuid
from datetime import datetime

from pydantic import BaseModel


class EventMetricPoint(BaseModel):
    bucket: datetime
    count: int
    expected_count: float | None = None
    # Stddev of the rolling baseline at this bucket — used by the UI to draw
    # a confidence band around `expected_count`. Only populated for buckets
    # that have an anomaly row; for the rest the band is undrawn.
    stddev: float | None = None
    is_anomaly: bool = False
    anomaly_direction: str | None = None
    z_score: float | None = None


class MetricSignalResponse(BaseModel):
    scan_config_id: uuid.UUID
    scope_type: str
    scope_ref: str
    state: str
    event_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    bucket: datetime
    actual_count: int
    expected_count: float
    stddev: float
    z_score: float
    direction: str


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
    scope_type: str
    scope_ref: str
    cells: list[SeasonalityCell]
    max_count: int
    total_count: int


class BreakdownTimelinePoint(BaseModel):
    bucket: datetime
    count: int


class BreakdownTimelineResponse(BaseModel):
    scan_config_id: uuid.UUID
    scope_type: str
    scope_ref: str
    breakdown_column: str
    breakdown_value: str
    is_other: bool
    interval: str | None
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
    event_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    interval: str | None = None
    latest_signal: MetricSignalResponse | None = None
    data: list[EventMetricPoint]
    forecast: list[ForecastPoint] = []


class EventMetricBreakdownSeries(BaseModel):
    breakdown_value: str
    is_other: bool = False
    total_count: int
    data: list[EventMetricPoint]


class EventMetricBreakdownsResponse(BaseModel):
    event_id: uuid.UUID
    scan_config_id: uuid.UUID | None = None
    interval: str | None = None
    columns: list[str]
    selected_column: str | None = None
    series: list[EventMetricBreakdownSeries]


class AppVersionInfo(BaseModel):
    version: str
    is_other: bool = False
    is_latest: bool = False


class AppVersionMetricSeries(BaseModel):
    version: str
    is_other: bool = False
    is_latest: bool = False
    total_count: int
    data: list[EventMetricPoint]


class AppVersionSeriesResponse(BaseModel):
    scan_config_id: uuid.UUID
    scope_type: str
    scope_ref: str
    event_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    app_version_column: str | None = None
    interval: str | None = None
    latest_version: str | None = None
    versions: list[AppVersionInfo]
    series: list[AppVersionMetricSeries]


class AppVersionAdoptionResponse(AppVersionSeriesResponse):
    totals: list[BreakdownTimelinePoint]


class TopMoverItem(BaseModel):
    """One row of "what moved this anomaly" — backed by MetricBreakdownAnomaly."""

    breakdown_column: str
    breakdown_value: str
    is_other: bool
    actual_count: int
    expected_count: float
    stddev: float
    z_score: float
    direction: str


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
    band: str
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
    interval: str | None = None
    total_count: int
    data: list[EventMetricPoint]
