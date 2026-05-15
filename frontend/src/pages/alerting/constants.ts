import type {
  AlertMessageFormat,
  AlertRule,
  AlertRuleFilterField,
  AlertRuleFilterOperator,
  AlertRuleFilterPayload,
} from "@/types"

export type DestinationFormState = {
  type: 'slack' | 'telegram'
  name: string
  enabled: boolean
  webhook_url: string
  bot_token: string
  chat_id: string
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
  include_project_total: boolean
  include_event_types: boolean
  include_events: boolean
  include_schema_drifts: boolean
  notify_on_spike: boolean
  notify_on_drop: boolean
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
  { name: 'scan_name', description: 'Scan config name' },
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
  { name: 'absolute_delta', description: 'Absolute delta' },
  { name: 'percent_delta', description: 'Percent delta' },
  { name: 'bucket', description: 'Anomaly bucket timestamp' },
  { name: 'details_url', description: 'Details URL' },
  { name: 'monitoring_url', description: 'Monitoring URL' },
  { name: 'details_line', description: 'Rendered details line with leading newline when URL exists' },
  { name: 'monitoring_line', description: 'Rendered monitoring line with leading newline when URL exists' },
  { name: 'drift_field', description: 'Schema drift field name' },
  { name: 'drift_type', description: 'Schema drift type' },
  { name: 'sample_value', description: 'Schema drift sample value' },
  { name: 'drift_line', description: 'Rendered schema drift line with leading newline when drift context exists' },
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

export const DEFAULT_ITEMS_TEMPLATES: Record<AlertMessageFormat, string> = {
  plain: '- ${scope_label} ${scope_name}: ${direction_label}, actual=${actual_count}, expected=${expected_count}, delta=${absolute_delta} (${percent_delta}%)${drift_line}${details_line}${monitoring_line}',
  slack_mrkdwn: '- ${scope_label} ${scope_name}: ${direction_label}, actual=${actual_count}, expected=${expected_count}, delta=${absolute_delta} (${percent_delta}%)${drift_line}${details_line}${monitoring_line}',
  telegram_html: '- ${scope_label} ${scope_name}: ${direction_label}, actual=${actual_count}, expected=${expected_count}, delta=${absolute_delta} (${percent_delta}%)${drift_line}${details_line}${monitoring_line}',
  telegram_markdownv2: '\\- ${scope_label} ${scope_name}: ${direction_label}, actual=${actual_count}, expected=${expected_count}, delta=${absolute_delta} \\(${percent_delta}%\\)${drift_line}${details_line}${monitoring_line}',
}

export const MESSAGE_FORMAT_OPTIONS: Record<'slack' | 'telegram', { value: AlertMessageFormat; label: string }[]> = {
  slack: [
    { value: 'plain', label: 'Plain text' },
    { value: 'slack_mrkdwn', label: 'Slack mrkdwn' },
  ],
  telegram: [
    { value: 'plain', label: 'Plain text' },
    { value: 'telegram_html', label: 'Telegram HTML' },
    { value: 'telegram_markdownv2', label: 'Telegram MarkdownV2' },
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

export function defaultDestinationForm(type: 'slack' | 'telegram'): DestinationFormState {
  return {
    type,
    name: '',
    enabled: true,
    webhook_url: '',
    bot_token: '',
    chat_id: '',
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

export function defaultRuleForm(): RuleFormState {
  return {
    name: '',
    enabled: true,
    include_project_total: true,
    include_event_types: true,
    include_events: true,
    include_schema_drifts: false,
    notify_on_spike: true,
    notify_on_drop: true,
    min_percent_delta: 0,
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
    include_project_total: rule.include_project_total,
    include_event_types: rule.include_event_types,
    include_events: rule.include_events,
    include_schema_drifts: rule.include_schema_drifts,
    notify_on_spike: rule.notify_on_spike,
    notify_on_drop: rule.notify_on_drop,
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
