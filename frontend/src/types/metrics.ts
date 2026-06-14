export interface EventMetricPoint {
  bucket: string
  count: number
  expected_count: number | null
  stddev: number | null
  is_anomaly: boolean
  anomaly_direction: 'spike' | 'drop' | null
  z_score: number | null
}

export interface MonitoringSignal {
  scan_config_id: string
  scope_type: 'project_total' | 'event_type' | 'event'
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
  scope_type: 'project_total' | 'event_type' | 'event' | null
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
  scope_type: string
  scope_ref: string
  cells: SeasonalityCell[]
  max_count: number
  total_count: number
}

export interface BreakdownTimelinePoint {
  bucket: string
  count: number
}

export interface BreakdownTimeline {
  scan_config_id: string
  scope_type: string
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
  event_id: string | null
  event_type_id: string | null
  interval: string | null
  latest_signal: MonitoringSignal | null
  data: EventMetricPoint[]
  forecast: ForecastPoint[]
}

export interface EventMetricBreakdownSeries {
  breakdown_value: string
  is_other: boolean
  total_count: number
  data: EventMetricPoint[]
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
}

export interface AppVersionMetricSeries {
  version: string
  is_other: boolean
  is_latest: boolean
  total_count: number
  data: EventMetricPoint[]
}

export interface AppVersionSeriesResponse {
  scan_config_id: string
  scope_type: 'project_total' | 'event_type' | 'event'
  scope_ref: string
  event_id: string | null
  event_type_id: string | null
  app_version_column: string | null
  interval: string | null
  latest_version: string | null
  versions: AppVersionInfo[]
  series: AppVersionMetricSeries[]
}

export interface AppVersionAdoptionResponse extends AppVersionSeriesResponse {
  totals: BreakdownTimelinePoint[]
}

export interface EventWindowMetrics {
  event_id: string
  scan_config_id: string | null
  interval: string | null
  total_count: number
  data: EventMetricPoint[]
}
