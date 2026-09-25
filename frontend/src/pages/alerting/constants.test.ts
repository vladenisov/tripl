import { describe, expect, it } from 'vitest'

import type { AlertRule } from '@/types'

import {
  ITEM_TEMPLATE_VARIABLE_OPTIONS,
  TEMPLATE_VARIABLE_OPTIONS,
  defaultRuleForm,
  findTemplateVariableToken,
  getDefaultItemsTemplate,
  getDefaultMessageTemplate,
  hasRuleFormProblems,
  messageFormatForDestination,
  ruleFormProblems,
  ruleFormToPayload,
  ruleToForm,
  unknownTemplateVariables,
  withMessageFormat,
  type RuleFormState,
} from './constants'

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule-1',
    destination_id: 'dest-1',
    scan_config_id: 'scan-1',
    name: 'Checkout drops',
    enabled: true,
    include_project_total: true,
    include_event_types: false,
    include_events: true,
    include_schema_drifts: false,
    include_distribution_drifts: false,
    include_release_regressions: false,
    include_variable_value_drifts: false,
    include_metrics: false,
    notify_on_spike: false,
    notify_on_drop: true,
    ai_explanation_enabled: false,
    min_percent_delta: 37.5,
    min_absolute_delta: 2,
    min_expected_count: 10,
    cooldown_minutes: 90,
    message_template: null,
    items_template: null,
    message_format: 'plain',
    filters: [{ id: 'f-1', field: 'direction', operator: 'eq', values: ['down'] }],
    muted: false,
    muted_until: null,
    total_deliveries: 0,
    incident_count: 0,
    last_delivery_at: null,
    last_delivery_status: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  } as AlertRule
}

function form(overrides: Partial<RuleFormState> = {}): RuleFormState {
  return { ...defaultRuleForm(), name: 'Rule', ...overrides }
}

describe('ruleToForm → ruleFormToPayload (ALR-43)', () => {
  it('round-trips a saved rule to the same settings on the wire', () => {
    const payload = ruleFormToPayload(ruleToForm(makeRule()))

    expect(payload).toMatchObject({
      name: 'Checkout drops',
      scan_config_id: 'scan-1',
      min_percent_delta: 37.5,
      min_absolute_delta: 2,
      min_expected_count: 10,
      cooldown_minutes: 90,
      notify_on_spike: false,
      notify_on_drop: true,
      message_format: 'plain',
      filters: [{ field: 'direction', operator: 'eq', values: ['down'] }],
    })
  })

  it('sends numbers, not the text the inputs hold (ALR-16)', () => {
    const payload = ruleFormToPayload(form({ cooldown_minutes: ' 45 ', min_percent_delta: '12.5' }))

    expect(payload.cooldown_minutes).toBe(45)
    expect(payload.min_percent_delta).toBe(12.5)
  })

  it('nulls templates that are still the defaults, and keeps an edited one', () => {
    expect(ruleFormToPayload(form()).message_template).toBeNull()
    expect(ruleFormToPayload(form()).items_template).toBeNull()
    expect(ruleFormToPayload(form({ message_template: 'Hi ${rule_name}' })).message_template)
      .toBe('Hi ${rule_name}')
  })

  it('sends an explicit null for "all scans"', () => {
    expect(ruleFormToPayload(form({ scan_config_id: '' }))).toHaveProperty('scan_config_id', null)
  })

  it('keeps a filter row with no values on the wire instead of silently widening the rule (ALR-5)', () => {
    const payload = ruleFormToPayload(
      form({ filters: [{ uid: 'f-1', field: 'event_type', operator: 'in', values: [] }] }),
    )

    expect(payload.filters).toEqual([{ field: 'event_type', operator: 'in', values: [] }])
  })

  it('sends one value for a single-value operator', () => {
    const payload = ruleFormToPayload(
      form({ filters: [{ uid: 'f-1', field: 'direction', operator: 'eq', values: ['up', 'down'] }] }),
    )

    expect(payload.filters).toEqual([{ field: 'direction', operator: 'eq', values: ['up'] }])
  })
})

describe('ruleFormProblems', () => {
  it('finds nothing wrong with the default form', () => {
    expect(hasRuleFormProblems(ruleFormProblems(form()))).toBe(false)
  })

  it('refuses an emptied or zero cooldown, and a fractional one (ALR-16)', () => {
    expect(ruleFormProblems(form({ cooldown_minutes: '' })).numeric.cooldown_minutes).toMatch(/number/)
    expect(ruleFormProblems(form({ cooldown_minutes: '0' })).numeric.cooldown_minutes).toMatch(/1 or more/)
    expect(ruleFormProblems(form({ cooldown_minutes: '1.5' })).numeric.cooldown_minutes).toMatch(/whole/)
  })

  it('refuses a negative or emptied threshold but accepts 0', () => {
    expect(ruleFormProblems(form({ min_percent_delta: '-1' })).numeric.min_percent_delta).toBeDefined()
    expect(ruleFormProblems(form({ min_absolute_delta: '' })).numeric.min_absolute_delta).toBeDefined()
    expect(ruleFormProblems(form({ min_expected_count: '0' })).numeric.min_expected_count).toBeUndefined()
  })

  it('names a filter row with no values by its uid (ALR-5)', () => {
    const problems = ruleFormProblems(
      form({ filters: [{ uid: 'f-9', field: 'event_type', operator: 'in', values: [] }] }),
    )

    expect(problems.filters['f-9']).toMatch(/at least one value/)
    expect(hasRuleFormProblems(problems)).toBe(true)
  })

  it('refuses a rule with no direction (ALR-14) or no scope (ALR-15)', () => {
    expect(ruleFormProblems(form({ notify_on_spike: false, notify_on_drop: false })).direction)
      .toMatch(/direction/)
    expect(
      ruleFormProblems(form({
        include_project_total: false,
        include_event_types: false,
        include_events: false,
      })).scopes,
    ).toMatch(/signal kind/)
  })
})

describe('message format on a destination switch (ALR-4)', () => {
  it('keeps a format the new channel supports', () => {
    expect(messageFormatForDestination('plain', 'telegram')).toBe('plain')
    expect(messageFormatForDestination('telegram_html', 'telegram')).toBe('telegram_html')
  })

  it('falls back to plain text for one it does not', () => {
    expect(messageFormatForDestination('slack_mrkdwn', 'telegram')).toBe('plain')
    expect(messageFormatForDestination('telegram_html', 'webhook')).toBe('plain')
  })

  it('carries default templates to the new format and leaves an edited one alone', () => {
    const untouched = withMessageFormat(
      form({
        message_format: 'slack_mrkdwn',
        message_template: getDefaultMessageTemplate('slack_mrkdwn'),
        items_template: getDefaultItemsTemplate('slack_mrkdwn'),
      }),
      'plain',
    )
    expect(untouched.message_template).toBe(getDefaultMessageTemplate('plain'))
    expect(untouched.items_template).toBe(getDefaultItemsTemplate('plain'))

    const edited = withMessageFormat(
      form({ message_format: 'slack_mrkdwn', message_template: '*mine*' }),
      'plain',
    )
    expect(edited.message_format).toBe('plain')
    expect(edited.message_template).toBe('*mine*')
  })
})

describe('unknownTemplateVariables (ALR-21)', () => {
  it('names a typo once, in the order it appears', () => {
    expect(
      unknownTemplateVariables('${scope_nme} ${rule_name} ${scope_nme} ${oops}', TEMPLATE_VARIABLE_OPTIONS),
    ).toEqual(['scope_nme', 'oops'])
  })

  it('flags an item variable used in the message template, and accepts it in the items one', () => {
    expect(unknownTemplateVariables('${scope_name}', TEMPLATE_VARIABLE_OPTIONS)).toEqual(['scope_name'])
    expect(unknownTemplateVariables('${scope_name}', ITEM_TEMPLATE_VARIABLE_OPTIONS)).toEqual([])
  })

  it('finds nothing wrong with either default template', () => {
    for (const format of ['plain', 'slack_mrkdwn', 'telegram_html', 'telegram_markdownv2'] as const) {
      expect(unknownTemplateVariables(getDefaultMessageTemplate(format), TEMPLATE_VARIABLE_OPTIONS)).toEqual([])
      expect(unknownTemplateVariables(getDefaultItemsTemplate(format), ITEM_TEMPLATE_VARIABLE_OPTIONS)).toEqual([])
    }
  })
})

describe('findTemplateVariableToken', () => {
  it('reads the half-typed variable before the cursor', () => {
    expect(findTemplateVariableToken('Hi ${rule_', 10)).toEqual({ start: 3, end: 10, query: 'rule_' })
  })

  it('ignores a closed variable and plain text', () => {
    expect(findTemplateVariableToken('${rule_name} x', 14)).toBeNull()
    expect(findTemplateVariableToken('no token', 8)).toBeNull()
  })
})
