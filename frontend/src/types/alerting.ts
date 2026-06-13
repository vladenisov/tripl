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
  ai_explanation_enabled: boolean
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

export type AlertInboxStatus =
  | 'open'
  | 'acknowledged'
  | 'resolved'
  | 'muted'
  | 'false_positive'

export interface AlertInboxGroup {
  correlation_group_id: string
  status: AlertInboxStatus
  muted_until: string | null
  note: string | null
  false_positive_count: number
  item_count: number
  delivery_count: number
  latest_bucket: string
  latest_delivery_at: string
  direction: string
  scope_names: string[]
  destination_names: string[]
  rule_names: string[]
  scan_names: string[]
  acted_at: string | null
  acted_by: string | null
}

export interface AlertInboxListResponse {
  items: AlertInboxGroup[]
  total: number
}

export type MonitorStatus = 'firing' | 'warning' | 'healthy'

export interface MonitorSummaryItem {
  rule_id: string
  rule_name: string
  destination_id: string
  destination_name: string
  destination_type: AlertDestinationType
  enabled: boolean
  status: MonitorStatus
  active_scope_count: number
  firing_scope_count: number
  last_anomaly_at: string | null
  last_notified_at: string | null
  notify_on_spike: boolean
  notify_on_drop: boolean
  min_percent_delta: number
  min_expected_count: number
  cooldown_minutes: number
}

export interface MonitorsSummaryResponse {
  monitors: MonitorSummaryItem[]
  firing_count: number
  warning_count: number
  healthy_count: number
  total: number
}
