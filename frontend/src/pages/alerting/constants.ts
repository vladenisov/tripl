import type {
  AlertDestinationType,
  AlertMessageFormat,
  AlertRule,
  AlertRuleFilterField,
  AlertRuleFilterOperator,
  AlertRuleFilterPayload,
} from "@/types"

// User-selectable channels for creating a real destination. The demo-only
// ``demo_sink`` (a local, non-sendable sink) is intentionally excluded here — it
// is created by the demo seeder, never through this create UI.
export type DestinationChannel = 'slack' | 'telegram' | 'webhook' | 'email' | 'jira' | 'linear'

export type DestinationFormState = {
  // Any existing destination's type when editing (incl. the read-only
  // ``demo_sink``); the create flow only ever sets a ``DestinationChannel``.
  type: AlertDestinationType
  name: string
  enabled: boolean
  webhook_url: string
  bot_token: string
  chat_id: string
  target_url: string
  webhook_header_name: string
  webhook_header_value: string
  email_recipients: string
  email_from_address: string
  email_subject_template: string
  jira_base_url: string
  jira_auth_email: string
  jira_api_token: string
  jira_project_key: string
  jira_issue_type: string
  linear_api_key: string
  linear_team_id: string
  linear_state_id: string
  linear_label_ids: string
}

export type RuleFilterDraft = {
  uid: string
  field: AlertRuleFilterField
  operator: AlertRuleFilterOperator
  values: string[]
}

export type RuleFormState = {
  name: string
  enabled: boolean
  // '' is the "All scans" option — the API wants null there, so
  // `ruleFormToPayload` converts. Radix Select cannot hold an empty value, so
  // the picker itself uses the `ALL_SCANS_OPTION` sentinel.
  scan_config_id: string
  include_project_total: boolean
  include_event_types: boolean
  include_events: boolean
  include_schema_drifts: boolean
  include_distribution_drifts: boolean
  include_release_regressions: boolean
  include_variable_value_drifts: boolean
  include_metrics: boolean
  notify_on_spike: boolean
  notify_on_drop: boolean
  ai_explanation_enabled: boolean
  min_percent_delta: number
  min_absolute_delta: number
  min_expected_count: number
  cooldown_minutes: number
  message_template: string
  items_template: string
  message_format: AlertMessageFormat
  filters: RuleFilterDraft[]
}

export const FILTER_FIELD_OPTIONS: { value: AlertRuleFilterField; label: string }[] = [
  { value: 'event_type', label: 'Event type' },
  { value: 'event', label: 'Event' },
  { value: 'direction', label: 'Direction' },
]

export const FILTER_OPERATOR_OPTIONS: { value: AlertRuleFilterOperator; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '!=' },
  { value: 'in', label: 'IN' },
  { value: 'not_in', label: 'NOT IN' },
]

export const DIRECTION_VALUE_OPTIONS = [
  { value: 'up', label: 'up' },
  { value: 'down', label: 'down' },
]

export function isSingleValueOperator(operator: AlertRuleFilterOperator) {
  return operator === 'eq' || operator === 'ne'
}

export function makeFilterUid() {
  return `f-${Math.random().toString(36).slice(2, 10)}`
}

export const TEMPLATE_VARIABLE_OPTIONS = [
  { name: 'project_name', description: 'Project display name' },
  { name: 'project_slug', description: 'Project slug' },
  { name: 'channel', description: 'Destination channel' },
  { name: 'destination_name', description: 'Destination name' },
  { name: 'rule_name', description: 'Rule name' },
  { name: 'scan_name', description: 'Scan name' },
  { name: 'matched_count', description: 'Number of matched alert items' },
  { name: 'items_count', description: 'Alias for matched_count' },
  { name: 'items_text', description: 'Preformatted list of all matched alert items' },
] as const

export const ITEM_TEMPLATE_VARIABLE_OPTIONS = [
  { name: 'scope_name', description: 'Matched scope name' },
  { name: 'scope_type', description: 'Matched scope type' },
  { name: 'scope_label', description: 'Matched scope label' },
  { name: 'direction', description: 'Direction: spike or drop' },
  { name: 'direction_label', description: 'Direction: up or down' },
  { name: 'actual_count', description: 'Actual count' },
  { name: 'expected_count', description: 'Expected count' },
  {
    name: 'expected_basis',
    description:
      'Says what the expected count was built from, when it is not a plain baseline — e.g. " (adoption-adjusted)" on a release regression. Empty for every other scope.',
  },
  { name: 'absolute_delta', description: 'Absolute delta' },
  // Named here rather than only in the docs because this list is what an
  // operator with a saved custom template reads while editing it: a template
  // written before `percent_delta_label` existed still prints "0.0%" at a zero
  // baseline, and nothing may rewrite it for them (tripl-l429.27).
  { name: 'percent_delta', description: 'Percent delta as a bare number. Prints 0 when there was no baseline, so prefer percent_delta_label unless you need the raw number' },
  { name: 'percent_delta_label', description: 'Percent delta with its "%" sign, or "no baseline" when expected is 0' },
  { name: 'bucket', description: 'Anomaly bucket timestamp' },
  { name: 'details_url', description: 'Details URL' },
  { name: 'monitoring_url', description: 'Monitoring URL' },
  { name: 'details_line', description: 'Rendered details line with leading newline when URL exists' },
  { name: 'monitoring_line', description: 'Rendered monitoring line with leading newline when URL exists' },
  { name: 'drift_field', description: 'Drift field name' },
  { name: 'drift_type', description: 'Drift type' },
  { name: 'sample_value', description: 'Drift sample value' },
  { name: 'drift_line', description: 'Rendered schema drift line with leading newline when drift context exists' },
  { name: 'sparkline', description: 'ASCII sparkline of recent bucket counts (empty if no history)' },
  { name: 'sparkline_line', description: 'Rendered sparkline with leading newline when history exists' },
  { name: 'top_movers', description: 'Inline summary of top-3 breakdown movers (empty if none)' },
  { name: 'top_movers_line', description: 'Rendered top-movers line with leading newline when movers exist' },
] as const

export const DEFAULT_MESSAGE_TEMPLATES: Record<AlertMessageFormat, string> = {
  plain: [
    '[tripl] ${matched_count} alerts',
    'Project delivery via ${channel}: ${destination_name}',
    'Rule: ${rule_name}',
    'Scan: ${scan_name}',
    '',
    '${items_text}',
  ].join('\n'),
  slack_mrkdwn: [
    '*[tripl] ${matched_count} alerts*',
    'Project delivery via ${channel}: ${destination_name}',
    'Rule: *${rule_name}*',
    'Scan: `${scan_name}`',
    '',
    '${items_text}',
  ].join('\n'),
  telegram_html: [
    '<b>[tripl] ${matched_count} alerts</b>',
    'Project delivery via ${channel}: ${destination_name}',
    'Rule: <b>${rule_name}</b>',
    'Scan: <code>${scan_name}</code>',
    '',
    '${items_text}',
  ].join('\n'),
  telegram_markdownv2: [
    '*tripl: ${matched_count} alerts*',
    'Project delivery via ${channel}: ${destination_name}',
    'Rule: *${rule_name}*',
    'Scan: `${scan_name}`',
    '',
    '${items_text}',
  ].join('\n'),
}

// `${percent_delta_label}` rather than a bare `${percent_delta}%`: the label
// carries its own unit, so it says "no baseline" for an item whose expected
// count is 0 instead of printing the undefined ratio as "0.0%".
//
// MIRRORS backend `alert_templates.DEFAULT_ALERT_ITEMS_TEMPLATES`, character for
// character, and a backend test asserts that. This is not decoration: the rule
// editor PREFILLS its editable textarea from here, so a variable missing below
// is a variable every hand-edited rule silently drops. That is how
// `${expected_basis}` — the qualifier that stops a release regression reading as
// a raw-count comparison — would have been lost, along with `${top_movers_line}`
// and `${sparkline_line}`, which had already drifted out unnoticed.
export const DEFAULT_ITEMS_TEMPLATES: Record<AlertMessageFormat, string> = {
  plain: '- ${scope_label} ${scope_name}: ${direction_label}, actual=${actual_count}, expected=${expected_count}${expected_basis}, delta=${absolute_delta} (${percent_delta_label})${drift_line}${details_line}${monitoring_line}${top_movers_line}${sparkline_line}',
  slack_mrkdwn: '- ${scope_label} ${scope_name}: ${direction_label}, actual=${actual_count}, expected=${expected_count}${expected_basis}, delta=${absolute_delta} (${percent_delta_label})${drift_line}${details_line}${monitoring_line}${top_movers_line}${sparkline_line}',
  telegram_html: '- ${scope_label} ${scope_name}: ${direction_label}, actual=${actual_count}, expected=${expected_count}${expected_basis}, delta=${absolute_delta} (${percent_delta_label})${drift_line}${details_line}${monitoring_line}${top_movers_line}${sparkline_line}',
  telegram_markdownv2: '\\- ${scope_label} ${scope_name}: ${direction_label}, actual=${actual_count}, expected=${expected_count}${expected_basis}, delta=${absolute_delta} \\(${percent_delta_label}\\)${drift_line}${details_line}${monitoring_line}${top_movers_line}${sparkline_line}',
}

export const MESSAGE_FORMAT_OPTIONS: Record<AlertDestinationType, { value: AlertMessageFormat; label: string }[]> = {
  slack: [
    { value: 'plain', label: 'Plain text' },
    { value: 'slack_mrkdwn', label: 'Slack mrkdwn' },
  ],
  telegram: [
    { value: 'plain', label: 'Plain text' },
    { value: 'telegram_html', label: 'Telegram HTML' },
    { value: 'telegram_markdownv2', label: 'Telegram MarkdownV2' },
  ],
  webhook: [
    { value: 'plain', label: 'Plain text' },
  ],
  email: [
    { value: 'plain', label: 'Plain text' },
  ],
  jira: [
    { value: 'plain', label: 'Plain text' },
  ],
  linear: [
    { value: 'plain', label: 'Plain text' },
  ],
  // Local demo sink renders plain text only (recorded locally, never sent).
  demo_sink: [
    { value: 'plain', label: 'Plain text' },
  ],
}

export const FORMAT_HELP: Record<AlertMessageFormat, string[]> = {
  plain: [
    'No rich formatting. Variables are inserted as plain text.',
  ],
  slack_mrkdwn: [
    '*bold*',
    '_italic_',
    '~strike~',
    '`code`',
    'Slack mrkdwn does not support underline.',
  ],
  telegram_html: [
    '<b>bold</b>',
    '<i>italic</i>',
    '<u>underline</u>',
    '<s>strike</s>',
    '<code>code</code>',
  ],
  telegram_markdownv2: [
    '*bold*',
    '_italic_',
    '__underline__',
    '~strike~',
    '`code`',
  ],
}

export function defaultDestinationForm(type: DestinationChannel): DestinationFormState {
  return {
    type,
    name: '',
    enabled: true,
    webhook_url: '',
    bot_token: '',
    chat_id: '',
    target_url: '',
    webhook_header_name: '',
    webhook_header_value: '',
    email_recipients: '',
    email_from_address: '',
    email_subject_template: '',
    jira_base_url: '',
    jira_auth_email: '',
    jira_api_token: '',
    jira_project_key: '',
    jira_issue_type: type === 'jira' ? 'Task' : '',
    linear_api_key: '',
    linear_team_id: '',
    linear_state_id: '',
    linear_label_ids: '',
  }
}

export function getDefaultMessageTemplate(messageFormat: AlertMessageFormat): string {
  return DEFAULT_MESSAGE_TEMPLATES[messageFormat]
}

export function getDefaultItemsTemplate(messageFormat: AlertMessageFormat): string {
  return DEFAULT_ITEMS_TEMPLATES[messageFormat]
}

export function normalizeRuleTemplate(value: string | null | undefined): string {
  return (value ?? '').trim()
}

export function isDefaultMessageTemplate(
  value: string | null | undefined,
  messageFormat: AlertMessageFormat,
): boolean {
  return normalizeRuleTemplate(value) === normalizeRuleTemplate(getDefaultMessageTemplate(messageFormat))
}

export function isDefaultItemsTemplate(
  value: string | null | undefined,
  messageFormat: AlertMessageFormat,
): boolean {
  return normalizeRuleTemplate(value) === normalizeRuleTemplate(getDefaultItemsTemplate(messageFormat))
}

// Radix Select rejects an empty string as an item value, so "every scan in the
// project" needs a sentinel in the picker even though the wire value is null.
export const ALL_SCANS_OPTION = 'all'

export function defaultRuleForm(): RuleFormState {
  return {
    name: '',
    enabled: true,
    scan_config_id: '',
    include_project_total: true,
    include_event_types: true,
    include_events: true,
    include_schema_drifts: false,
    include_distribution_drifts: false,
    include_release_regressions: false,
    include_variable_value_drifts: false,
    include_metrics: false,
    notify_on_spike: true,
    notify_on_drop: true,
    ai_explanation_enabled: false,
    // Matches the server default — DEFAULT_MIN_PERCENT_DELTA in
    // backend/src/tripl/models/alert_rule.py. A new rule watches moves of at
    // least double or at most half, not every deviation; a form that opened at
    // 0 would quietly disagree with the API.
    min_percent_delta: 100,
    min_absolute_delta: 0,
    min_expected_count: 0,
    cooldown_minutes: 1440,
    message_template: getDefaultMessageTemplate('plain'),
    items_template: getDefaultItemsTemplate('plain'),
    message_format: 'plain',
    filters: [],
  }
}

export function ruleToForm(rule: AlertRule): RuleFormState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    scan_config_id: rule.scan_config_id ?? '',
    include_project_total: rule.include_project_total,
    include_event_types: rule.include_event_types,
    include_events: rule.include_events,
    include_schema_drifts: rule.include_schema_drifts,
    include_distribution_drifts: rule.include_distribution_drifts,
    include_release_regressions: rule.include_release_regressions,
    include_variable_value_drifts: rule.include_variable_value_drifts,
    include_metrics: rule.include_metrics,
    notify_on_spike: rule.notify_on_spike,
    notify_on_drop: rule.notify_on_drop,
    ai_explanation_enabled: rule.ai_explanation_enabled,
    min_percent_delta: rule.min_percent_delta,
    min_absolute_delta: rule.min_absolute_delta,
    min_expected_count: rule.min_expected_count,
    cooldown_minutes: rule.cooldown_minutes,
    message_template: rule.message_template ?? getDefaultMessageTemplate(rule.message_format),
    items_template: rule.items_template ?? getDefaultItemsTemplate(rule.message_format),
    message_format: rule.message_format,
    filters: rule.filters.map(filter => ({
      uid: filter.id,
      field: filter.field,
      operator: filter.operator,
      values: [...filter.values],
    })),
  }
}

export function ruleFormToPayload(ruleForm: RuleFormState) {
  const normalizedTemplate = normalizeRuleTemplate(ruleForm.message_template)
  const normalizedItemsTemplate = normalizeRuleTemplate(ruleForm.items_template)
  const filters: AlertRuleFilterPayload[] = ruleForm.filters
    .filter(filter => filter.values.length > 0)
    .map(filter => ({
      field: filter.field,
      operator: filter.operator,
      values: isSingleValueOperator(filter.operator)
        ? filter.values.slice(0, 1)
        : filter.values,
    }))
  const { filters: _ignored, ...rest } = ruleForm
  void _ignored
  return {
    ...rest,
    // Explicit null, never omitted: PATCH distinguishes "not mentioned" from
    // "widen this rule back to the whole project".
    scan_config_id: ruleForm.scan_config_id || null,
    filters,
    message_template:
      !normalizedTemplate || isDefaultMessageTemplate(normalizedTemplate, ruleForm.message_format)
        ? null
        : normalizedTemplate,
    items_template:
      !normalizedItemsTemplate || isDefaultItemsTemplate(normalizedItemsTemplate, ruleForm.message_format)
        ? null
        : normalizedItemsTemplate,
  }
}

export function formatCooldown(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

export function scopeSummary(rule: AlertRule) {
  return [
    rule.include_project_total ? 'total' : null,
    rule.include_event_types ? 'groups' : null,
    rule.include_events ? 'events' : null,
    rule.include_schema_drifts ? 'schema' : null,
    rule.include_distribution_drifts ? 'distribution' : null,
    rule.include_release_regressions ? 'regressions' : null,
    rule.include_variable_value_drifts ? 'value drift' : null,
    rule.include_metrics ? 'metrics' : null,
  ].filter(Boolean).join(', ')
}

export function directionSummary(rule: AlertRule) {
  return [
    rule.notify_on_spike ? 'up' : null,
    rule.notify_on_drop ? 'down' : null,
  ].filter(Boolean).join(' / ')
}

export function findTemplateVariableToken(value: string, cursor: number) {
  const beforeCursor = value.slice(0, cursor)
  const start = beforeCursor.lastIndexOf('${')
  if (start === -1) return null
  if (beforeCursor.indexOf('}', start) !== -1) return null
  const query = beforeCursor.slice(start + 2)
  if (!/^[a-zA-Z0-9_]*$/.test(query)) return null
  return { start, end: cursor, query }
}
