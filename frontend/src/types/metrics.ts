// Exhaustive scope-type union mirroring the backend MetricScopeType enum
// (backend/src/tripl/models/domain_enums.py). Keep all eight members in sync;
// narrowing this to a subset silently mis-routes the omitted scopes.
export type MetricScopeType =
  | 'project_total'
  | 'event_type'
  | 'event'
  | 'schema'
  | 'distribution'
  | 'release_regression'
  | 'metric'
  | 'variable_value_drift'

export interface EventMetricPoint {
  bucket: string
  count: number
  expected_count: number | null
  stddev: number | null
  is_anomaly: boolean
  anomaly_direction: 'spike' | 'drop' | null
  z_score: number | null
  detector_kind?: string | null
}

export interface TopEvent {
  event_id: string
  name: string
  event_type_id: string
  total_count: number
}

export interface OverviewKpiSeries {
  days: number
  // Events CREATED per day on the main branch. Named `active_events` until
  // tripl-jfm3.22, which is what led the Overview sparkline to announce itself
  // as "Active events by day" while plotting creations across every branch.
  new_events: number[]
}

export interface MonitoringSignal {
  scan_config_id: string
  scope_type: MetricScopeType
  scope_ref: string
  state: 'latest_scan' | 'recent'
  event_id: string | null
  event_type_id: string | null
  bucket: string
  actual_count: number
  expected_count: number
  stddev: number
  z_score: number
  direction: 'spike' | 'drop'
  // True when this row is a child scope (event_type/event) folded under a
  // co-firing project_total incident. Only the expanded AnomaliesPage fetch
  // sets it; collapsed callers drop children so it is always false there.
  incident_child: boolean
}

export interface TopMoverItem {
  breakdown_column: string
  breakdown_value: string
  is_other: boolean
  actual_count: number
  expected_count: number
  stddev: number
  z_score: number
  direction: 'spike' | 'drop'
}

export type DistributionDriftBand = 'stable' | 'minor' | 'significant'

export interface DistributionDriftTopMover {
  value: string
  baseline_share: number
  current_share: number
  contribution: number
}

export interface DistributionDriftPoint {
  id: string
  scan_config_id: string
  event_type_id: string | null
  field_name: string
  bucket: string
  psi: number
  band: DistributionDriftBand
  baseline_total: number
  current_total: number
  top_movers: DistributionDriftTopMover[]
}

export interface DistributionDriftsResponse {
  scope: 'project_total' | 'event_type' | 'event'
  scan_config_id: string | null
  event_type_id: string | null
  fields: string[]
  data: DistributionDriftPoint[]
}

export interface ForecastPoint {
  bucket: string
  expected_count: number
  stddev: number
}

export interface ChartAnnotation {
  id: string
  project_id: string
  scope_type: 'project_total' | 'event_type' | 'event' | 'metric' | null
  scope_ref: string | null
  bucket: string
  label: string
  description: string | null
  color: string
  created_by_user_id: string | null
  created_at: string
}

export interface SeasonalityCell {
  weekday: number
  hour: number
  count: number
  anomaly_count: number
}

export interface SeasonalityHeatmap {
  scan_config_id: string
  scope_type: MetricScopeType
  scope_ref: string
  cells: SeasonalityCell[]
  max_count: number
  total_count: number
  // The scan interval the cells were binned from. A daily/weekly scan puts every
  // bucket in hour 0, so the 7×24 grid can never fill and must not be drawn
  // (tripl-jfm3.128).
  interval: string
  hourly_resolution: boolean
}

export interface BreakdownTimelinePoint {
  bucket: string
  count: number
}

export interface BreakdownTimeline {
  scan_config_id: string
  scope_type: MetricScopeType
  scope_ref: string
  breakdown_column: string
  breakdown_value: string
  is_other: boolean
  interval: string | null
  data: BreakdownTimelinePoint[]
}

export interface EventMetricsResponse {
  scope: 'project_total' | 'event_type' | 'event' | 'events_total'
  scan_config_id: string | null
  // Display name of the single scan config the `project_total` / `events_total`
  // series is scoped to, so the chart can name its scope instead of implying
  // it covers every scan in the project (tripl-jfm3.20). Optional like
  // `sigma_threshold`: the server always sends it (null for scopes that have no
  // single scan), but locally-synthesised responses need not fabricate one.
  scan_config_name?: string | null
  event_id: string | null
  event_type_id: string | null
  interval: string | null
  latest_signal: MonitoringSignal | null
  sigma_threshold?: number
  data: EventMetricPoint[]
  forecast: ForecastPoint[]
}

export interface EventMetricBreakdownSeries {
  breakdown_value: string
  is_other: boolean
  total_count: number
  data: EventMetricPoint[]
  parity_anomalies: PlatformParityAnomaly[]
}

export interface PlatformParityAnomaly {
  bucket: string
  actual_share: number
  expected_share: number
  stddev: number
  z_score: number
  direction: 'spike' | 'drop'
}

export interface EventMetricBreakdownsResponse {
  event_id: string
  scan_config_id: string | null
  interval: string | null
  columns: string[]
  selected_column: string | null
  series: EventMetricBreakdownSeries[]
}

export interface AppVersionInfo {
  version: string
  is_other: boolean
  is_latest: boolean
  is_active: boolean
}

export interface AppVersionMetricSeries {
  version: string
  is_other: boolean
  is_latest: boolean
  is_active: boolean
  total_count: number
  data: EventMetricPoint[]
}

export interface AppVersionSeriesResponse {
  scan_config_id: string
  scope_type: MetricScopeType
  scope_ref: string
  event_id: string | null
  event_type_id: string | null
  app_version_column: string | null
  interval: string | null
  latest_version: string | null
  sigma_threshold?: number
  versions: AppVersionInfo[]
  series: AppVersionMetricSeries[]
}

export interface AppVersionAdoptionResponse extends AppVersionSeriesResponse {
  totals: BreakdownTimelinePoint[]
}

export interface ReleaseRegressionItem {
  scope_type: MetricScopeType
  scope_ref: string
  scope_name: string
  event_id: string | null
  event_type_id: string | null
  kind: 'missing' | 'volume_drop'
  version: string
  previous_version: string
  observed_count: number
  expected_count: number
  ratio: number
  share_prev: number
  share_new: number
  release_share: number
  window_from: string
  window_to: string
}

export interface ReleaseRegressionsResponse {
  scan_config_id: string
  app_version_column: string | null
  latest_version: string | null
  items: ReleaseRegressionItem[]
}

export interface EventWindowMetrics {
  event_id: string
  scan_config_id: string | null
  interval: string | null
  total_count: number
  data: EventMetricPoint[]
}
