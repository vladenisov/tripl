import type { MetricScopeType } from './metrics'

export interface ScanJobResultSummary {
  mode?: 'metrics_collection' | 'metrics_replay'
  catalog_sync_skipped?: boolean
  time_from?: string
  time_to?: string
  events_created?: number
  events_skipped?: number
  events_grouped?: number
  events_merged?: number
  variables_created?: number
  variable_values_touched?: number
  columns_analyzed?: number
  event_metrics?: number
  type_metrics?: number
  breakdown_event_metrics?: number
  breakdown_type_metrics?: number
  metrics_deleted?: number
  breakdown_metrics_deleted?: number
  distribution_drifts?: number
  significant_distribution_drifts?: number
  distribution_drifts_deleted?: number
  contract_violations_detected?: number
  anomalies_detected?: number
  breakdown_anomalies_detected?: number
  signals_added?: number
  signals_removed?: number
  alerts_queued?: number
  scan_row_limit?: number
  scan_rows_processed?: number
  scan_truncated?: boolean
  metrics_row_limit?: number
  query_rows_scanned?: number
  replay_chunk_interval?: string
  replay_chunks_total?: number
  replay_chunks_completed?: number
  replay_current_chunk_index?: number | null
  replay_current_chunk_from?: string | null
  replay_current_chunk_to?: string | null
  replay_progress_percent?: number
  replay_progress_phase?: 'preparing' | 'collecting' | 'finalizing' | 'completed'
  details?: string[]
}

export interface ProjectLatestScanJob {
  id: string
  scan_config_id: string
  scan_name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  started_at: string | null
  completed_at: string | null
  result_summary: ScanJobResultSummary | null
  error_message: string | null
  created_at: string
}

export interface ProjectLatestSignal {
  scan_config_id: string
  scan_name: string
  scope_type: MetricScopeType
  scope_ref: string
  scope_name: string
  state: 'latest_scan' | 'recent'
  bucket: string
  actual_count: number
  expected_count: number
  z_score: number
  direction: 'spike' | 'drop'
}

export type IntervalCode = '15m' | '1h' | '6h' | '1d' | '1w'

export interface EventGroupCondition {
  field: string
  pattern: string
}

export interface EventGroupRule {
  name: string
  condition_logic: 'all' | 'any'
  conditions: EventGroupCondition[]
}

export interface ScanConfig {
  id: string
  data_source_id: string
  project_id: string
  event_type_id: string | null
  name: string
  base_query: string
  event_type_column: string | null
  time_column: string | null
  event_name_format: string | null
  json_value_paths: string[]
  event_group_rules: EventGroupRule[]
  metric_breakdown_columns: string[]
  metric_breakdown_values_limit: number | null
  distribution_drift_fields: string[]
  cardinality_threshold: number
  interval: IntervalCode | null
  replay_chunk_interval: IntervalCode | null
  scan_lookback_hours: number | null
  scan_row_limit: number | null
  metrics_row_limit: number | null
  app_version_column: string | null
  app_version_keep_releases: number | null
  app_version_prerelease_pattern: string | null
  app_version_active_share_min: number | null
  platform_column: string | null
  created_at: string
  updated_at: string
}

export interface PlatformPresenceRow {
  event_id: string
  event_name: string
  present_platforms: string[]
}

export interface PlatformPresenceResponse {
  scan_config_id: string
  platform_column: string | null
  platforms: string[]
  items: PlatformPresenceRow[]
}

export interface ScanPreviewColumn {
  name: string
  type_name: string
  is_nullable: boolean
}

export interface ScanPreviewJsonPath {
  full_path: string
  path: string
  sample_values: string[]
}

export interface ScanPreviewJsonColumn {
  column: string
  paths: ScanPreviewJsonPath[]
}

export interface ScanConfigPreview {
  columns: ScanPreviewColumn[]
  rows: Record<string, unknown>[]
  json_columns: ScanPreviewJsonColumn[]
}

export interface ScanPreviewJob {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  started_at: string | null
  completed_at: string | null
  // Holds a ScanConfigPreview when status === 'completed'; null otherwise.
  result_summary: ScanConfigPreview | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface ProjectAnomalySettings {
  id: string
  project_id: string
  anomaly_detection_enabled: boolean
  detect_project_total: boolean
  detect_event_types: boolean
  detect_events: boolean
  // Catalog metrics (Metrics tab) are scored on their own series, independent
  // of the event-scope flags above.
  detect_metrics: boolean
  baseline_window_buckets: number
  min_history_buckets: number
  sigma_threshold: number
  min_expected_count: number
  // How long a detected anomaly keeps counting as an "open" signal for the
  // Anomalies page and the sidebar badge.
  recent_signal_window_hours: number
  // Wall-clock allowance for the warehouse to finish delivering a bucket before
  // that bucket is scored. Holds the newest buckets back from raising signals.
  anomaly_ingestion_settling_minutes: number
  created_at: string
  updated_at: string
}

export interface ScanJob {
  id: string
  scan_config_id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  started_at: string | null
  completed_at: string | null
  result_summary: ScanJobResultSummary | null
  error_message: string | null
  created_at: string
  updated_at: string
}
