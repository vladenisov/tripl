export interface ScanJobResultSummary {
  mode?: 'metrics_collection' | 'metrics_replay'
  time_from?: string
  time_to?: string
  events_created?: number
  events_skipped?: number
  variables_created?: number
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
  anomalies_detected?: number
  breakdown_anomalies_detected?: number
  signals_added?: number
  signals_removed?: number
  alerts_queued?: number
  details?: string[]
}

export interface ProjectLatestScanJob {
  id: string
  scan_config_id: string
  scan_name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  started_at: string | null
  completed_at: string | null
  result_summary: ScanJobResultSummary | null
  error_message: string | null
  created_at: string
}

export interface ProjectLatestSignal {
  scan_config_id: string
  scan_name: string
  scope_type: 'project_total' | 'event_type' | 'event'
  scope_ref: string
  scope_name: string
  state: 'latest_scan' | 'recent'
  bucket: string
  actual_count: number
  expected_count: number
  z_score: number
  direction: 'spike' | 'drop'
}

export type Role = 'owner' | 'editor' | 'viewer'

export const ROLE_OPTIONS: { value: Role; label: string; chip: string }[] = [
  { value: 'owner', label: 'Owner', chip: 'bg-violet-500/15 text-violet-700' },
  { value: 'editor', label: 'Editor', chip: 'bg-sky-500/15 text-sky-700' },
  { value: 'viewer', label: 'Viewer', chip: 'bg-muted text-muted-foreground' },
]

export interface AuthUser {
  id: string
  email: string
  name: string | null
  role: Role
  created_at: string
  updated_at: string
}

export interface UserListItem {
  id: string
  email: string
  name: string | null
  role: Role
  created_at: string
}

export interface EventTypeOwner {
  id: string
  event_type_id: string
  user_id: string
  user_email: string
  user_name: string
  granted_by: string | null
  created_at: string
}

export interface ProjectSummary {
  event_type_count: number
  event_count: number
  active_event_count: number
  implemented_event_count: number
  review_pending_event_count: number
  archived_event_count: number
  variable_count: number
  scan_count: number
  alert_destination_count: number
  monitoring_signal_count: number
  latest_scan_job: ProjectLatestScanJob | null
  latest_signal: ProjectLatestSignal | null
}

export interface Project {
  id: string
  name: string
  slug: string
  description: string
  created_at: string
  updated_at: string
  summary: ProjectSummary
}

export type ActivityItemType = 'anomaly' | 'scan' | 'alert' | 'event'
export type ActivityItemSeverity = 'high' | 'medium' | 'low'

export interface ActivityItem {
  id: string
  project_id: string
  project_slug: string
  project_name: string
  type: ActivityItemType
  severity: ActivityItemSeverity
  title: string
  detail: string
  occurred_at: string
  target_path: string | null
}

export interface EventType {
  id: string
  project_id: string
  name: string
  display_name: string
  description: string
  color: string
  order: number
  created_at: string
  updated_at: string
  field_definitions: FieldDefinition[]
}

export interface EventTypeBrief {
  id: string
  name: string
  display_name: string
  color: string
}

export interface FieldDefinition {
  id: string
  event_type_id: string
  name: string
  display_name: string
  field_type: 'string' | 'number' | 'boolean' | 'json' | 'enum' | 'url'
  is_required: boolean
  enum_options: string[] | null
  description: string
  order: number
  sensitivity: Sensitivity
}

export type Sensitivity = 'none' | 'pii' | 'phi' | 'financial' | 'secret'

export const SENSITIVITY_OPTIONS: {
  value: Sensitivity
  label: string
  chip: string
}[] = [
  { value: 'none', label: 'None', chip: 'bg-muted text-muted-foreground' },
  { value: 'pii', label: 'PII', chip: 'bg-rose-500/15 text-rose-700' },
  { value: 'phi', label: 'PHI', chip: 'bg-purple-500/15 text-purple-700' },
  { value: 'financial', label: 'Financial', chip: 'bg-amber-500/15 text-amber-700' },
  { value: 'secret', label: 'Secret', chip: 'bg-slate-800/80 text-slate-100' },
]

export interface EventTypeRelation {
  id: string
  project_id: string
  source_event_type_id: string
  target_event_type_id: string
  source_field_id: string
  target_field_id: string
  relation_type: string
  description: string
}

export interface MetaFieldDefinition {
  id: string
  project_id: string
  name: string
  display_name: string
  field_type: 'string' | 'url' | 'boolean' | 'enum' | 'date'
  is_required: boolean
  enum_options: string[] | null
  default_value: string | null
  link_template: string | null
  order: number
  sensitivity: Sensitivity
}

export interface EventFieldValue {
  id: string
  field_definition_id: string
  value: string
}

export interface EventMetaValue {
  id: string
  meta_field_definition_id: string
  value: string
}

export interface EventTag {
  id: string
  name: string
}

export interface Event {
  id: string
  project_id: string
  event_type_id: string
  event_type: EventTypeBrief
  name: string
  description: string
  order: number
  implemented: boolean
  reviewed: boolean
  archived: boolean
  last_seen_at: string | null
  metric_breakdown_columns: string[]
  drift_count: number
  tags: EventTag[]
  field_values: EventFieldValue[]
  meta_values: EventMetaValue[]
  created_at: string
  updated_at: string
}

export type SchemaDriftType = 'new_field' | 'missing_field' | 'type_changed'

export interface SchemaDrift {
  id: string
  event_type_id: string
  scan_config_id: string | null
  field_name: string
  drift_type: SchemaDriftType
  observed_type: string | null
  declared_type: string | null
  sample_value: string | null
  detected_at: string
}

export interface SchemaDriftList {
  items: SchemaDrift[]
  total: number
}

// Slim shape returned by GET /events: drops nested event_type since the
// frontend already has EventTypes cached and looks them up by id.
export type EventListItem = Omit<Event, 'event_type'>

export interface EventListResponse {
  items: EventListItem[]
  total: number
}

export type EventPhotoKind = 'photo' | 'figma'

export interface EventPhoto {
  id: string
  event_id: string
  project_id: string
  kind: EventPhotoKind
  original_filename: string
  content_type: string
  size_bytes: number
  storage_backend: 'local' | 'gcs' | null
  sort_order: number
  url: string
  external_url: string | null
  uploaded_by_user_id: string | null
  created_at: string
}

export interface EventPhotoComment {
  id: string
  photo_id: string
  parent_id: string | null
  user_id: string | null
  body: string
  created_at: string
  updated_at: string
}

export type VariableType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'string_array' | 'number_array'

export interface Variable {
  id: string
  project_id: string
  name: string
  source_name: string | null
  variable_type: VariableType
  description: string
}

export type DbType = 'clickhouse' | 'postgres' | 'bigquery'

export const DB_TYPE_OPTIONS: { value: DbType; label: string; defaultPort: number }[] = [
  { value: 'clickhouse', label: 'ClickHouse', defaultPort: 8123 },
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'bigquery', label: 'BigQuery', defaultPort: 0 },
]

export type DataSourceTestStatus = 'success' | 'failed'

export interface DataSource {
  id: string
  name: string
  db_type: DbType
  host: string
  port: number
  database_name: string
  username: string
  password_set: boolean
  extra_params: Record<string, unknown> | null
  last_test_at: string | null
  last_test_status: DataSourceTestStatus | null
  last_test_message: string | null
  created_at: string
  updated_at: string
}

export interface DataSourceTestResult {
  success: boolean
  message: string
  tested_at: string
  data_source: DataSource
}

export type IntervalCode = '15m' | '1h' | '6h' | '1d' | '1w'

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
  metric_breakdown_columns: string[]
  metric_breakdown_values_limit: number | null
  distribution_drift_fields: string[]
  cardinality_threshold: number
  interval: IntervalCode | null
  replay_chunk_interval: IntervalCode | null
  created_at: string
  updated_at: string
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

export interface ProjectAnomalySettings {
  id: string
  project_id: string
  anomaly_detection_enabled: boolean
  detect_project_total: boolean
  detect_event_types: boolean
  detect_events: boolean
  baseline_window_buckets: number
  min_history_buckets: number
  sigma_threshold: number
  min_expected_count: number
  created_at: string
  updated_at: string
}

export interface ScanJob {
  id: string
  scan_config_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  started_at: string | null
  completed_at: string | null
  result_summary: ScanJobResultSummary | null
  error_message: string | null
  created_at: string
  updated_at: string
}

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

export interface EventWindowMetrics {
  event_id: string
  scan_config_id: string | null
  interval: string | null
  total_count: number
  data: EventMetricPoint[]
}

export type AlertDestinationType = 'slack' | 'telegram' | 'webhook' | 'email' | 'jira' | 'linear'
export type AlertDeliveryStatus = 'pending' | 'sent' | 'failed'
export type AlertMessageFormat =
  | 'plain'
  | 'slack_mrkdwn'
  | 'telegram_html'
  | 'telegram_markdownv2'

export interface AlertRule {
  id: string
  destination_id: string
  name: string
  enabled: boolean
  include_project_total: boolean
  include_event_types: boolean
  include_events: boolean
  include_schema_drifts: boolean
  include_distribution_drifts: boolean
  notify_on_spike: boolean
  notify_on_drop: boolean
  min_percent_delta: number
  min_absolute_delta: number
  min_expected_count: number
  cooldown_minutes: number
  message_template: string | null
  items_template: string | null
  message_format: AlertMessageFormat
  filters: AlertRuleFilter[]
  created_at: string
  updated_at: string
}

export type AlertRuleFilterField = 'event_type' | 'event' | 'direction'
export type AlertRuleFilterOperator = 'eq' | 'ne' | 'in' | 'not_in'

export interface AlertRuleFilter {
  id: string
  field: AlertRuleFilterField
  operator: AlertRuleFilterOperator
  values: string[]
}

export interface AlertRuleFilterPayload {
  field: AlertRuleFilterField
  operator: AlertRuleFilterOperator
  values: string[]
}

export interface AlertDestination {
  id: string
  project_id: string
  type: AlertDestinationType
  name: string
  enabled: boolean
  webhook_set: boolean
  bot_token_set: boolean
  chat_id: string | null
  target_url_set: boolean
  webhook_header_name: string | null
  email_recipients: string | null
  email_from_address: string | null
  email_subject_template: string | null
  jira_base_url: string | null
  jira_auth_email: string | null
  jira_api_token_set: boolean
  jira_project_key: string | null
  jira_issue_type: string | null
  linear_api_key_set: boolean
  linear_team_id: string | null
  linear_state_id: string | null
  linear_label_ids: string | null
  rules: AlertRule[]
  created_at: string
  updated_at: string
}

export interface SimulatedRuleFiring {
  anomaly_id: string
  scope_type: 'project_total' | 'event_type' | 'event' | 'schema' | 'distribution'
  scope_ref: string
  scope_name: string
  event_type_id: string | null
  event_id: string | null
  drift_field: string | null
  drift_type: string | null
  sample_value: string | null
  bucket: string
  direction: 'spike' | 'drop'
  actual_count: number
  expected_count: number
  absolute_delta: number
  percent_delta: number
  rendered_item: string | null
}

export interface AlertRuleSimulateResponse {
  rule_id: string
  rule_name: string
  days: number
  window_from: string
  window_to: string
  anomalies_considered: number
  matched_before_cooldown: number
  firings: SimulatedRuleFiring[]
  noisy: boolean
  cooldown_minutes_used: number
  cooldown_minutes_saved: number
  rendered_message: string | null
}

export interface AlertDeliveryItem {
  id: string
  delivery_id: string
  scope_type: 'project_total' | 'event_type' | 'event' | 'schema' | 'distribution'
  scope_ref: string
  scope_name: string
  event_type_id: string | null
  event_id: string | null
  bucket: string
  direction: 'spike' | 'drop'
  actual_count: number
  expected_count: number
  absolute_delta: number
  percent_delta: number
  details_path: string | null
  monitoring_path: string | null
  drift_field: string | null
  drift_type: string | null
  sample_value: string | null
  correlation_group_id: string | null
}

export interface AlertDelivery {
  id: string
  project_id: string
  scan_config_id: string
  scan_job_id: string | null
  destination_id: string
  rule_id: string
  destination_name: string
  rule_name: string
  scan_name: string
  status: AlertDeliveryStatus
  channel: AlertDestinationType
  matched_count: number
  payload_snapshot: Record<string, unknown> | null
  error_message: string | null
  created_at: string
  updated_at: string
  sent_at: string | null
}

export interface AlertDeliveryDetail extends AlertDelivery {
  items: AlertDeliveryItem[]
}

export interface AlertDeliveryListResponse {
  items: AlertDelivery[]
  total: number
}

export interface PlanRevisionEntityCounts {
  event_types: number
  fields: number
  events: number
  variables: number
  meta_fields: number
  relations: number
}

export interface PlanRevisionSummary {
  id: string
  project_id: string
  summary: string
  created_at: string
  created_by: string | null
  entity_counts: PlanRevisionEntityCounts
}

export interface PlanRevisionDetail extends PlanRevisionSummary {
  payload: Record<string, unknown>
}

export type PlanBranchKind = 'main' | 'working'

export type PlanBranchStatus =
  | 'draft'
  | 'ready_for_review'
  | 'changes_requested'
  | 'approved'
  | 'merged'
  | 'closed'

export type PlanBranchTransitionAction =
  | 'submit'
  | 'request_changes'
  | 'approve'
  | 'reopen'
  | 'close'

export interface PlanBranchSummary {
  id: string
  project_id: string
  name: string
  kind: PlanBranchKind
  status: PlanBranchStatus
  description: string
  base_revision_id: string | null
  created_by: string | null
  merged_at: string | null
  merged_by: string | null
  created_at: string
  updated_at: string
}

export interface PlanBranchReviewer {
  id: string
  user_id: string
  created_at: string
}

export interface PlanBranchApproval {
  user_id: string | null
  approved_at: string
}

export interface PlanBranchDetail extends PlanBranchSummary {
  reviewers: PlanBranchReviewer[]
  approvals: PlanBranchApproval[]
}

export interface PlanBranchList {
  items: PlanBranchSummary[]
  total: number
}

export interface PlanBranchComment {
  id: string
  branch_id: string
  parent_id: string | null
  user_id: string | null
  body: string
  created_at: string
  updated_at: string
}

export interface PlanBranchDiffSummary {
  entries: PlanDiffEntry[]
  summary: { added: number; removed: number; changed: number }
  behind_base: boolean
}

export interface PlanRevisionList {
  items: PlanRevisionSummary[]
  total: number
}

export type PlanDiffEntityType =
  | 'event_type'
  | 'field_definition'
  | 'event'
  | 'variable'
  | 'meta_field'
  | 'relation'

export type PlanDiffKind = 'added' | 'removed' | 'changed'

export interface PlanDiffEntry {
  entity_type: PlanDiffEntityType
  kind: PlanDiffKind
  name: string
  parent: string | null
  changes: string[]
}

export interface PlanDiff {
  revision_id: string
  compare_to: string
  entries: PlanDiffEntry[]
  summary: { added: number; removed: number; changed: number }
}

export interface AuditEntry {
  id: string
  created_at: string
  user_id: string | null
  user_email: string
  project_id: string | null
  project_slug: string
  action: string
  target_type: string
  target_id: string | null
  target_name: string
  payload: Record<string, unknown>
}

export interface AuditListResponse {
  items: AuditEntry[]
  total: number
}
