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


class EventMetricsResponse(BaseModel):
    scope: str
    scan_config_id: uuid.UUID | None = None
    event_id: uuid.UUID | None = None
    event_type_id: uuid.UUID | None = None
    interval: str | None = None
    latest_signal: MetricSignalResponse | None = None
    data: list[EventMetricPoint]


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
