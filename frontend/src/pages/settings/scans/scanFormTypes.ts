import type { EventGroupRule } from '@/types'

// Client-only UI state: each rule/condition carries a stable `_uid` so React keys
// don't reattach controlled-input state to the wrong row when a middle item is
// removed. The `_uid` is stripped before the payload reaches the API.
export type UiEventGroupCondition = EventGroupRule['conditions'][number] & { _uid: string }
export type UiEventGroupRule = Omit<EventGroupRule, 'conditions'> & {
  _uid: string
  conditions: UiEventGroupCondition[]
}

function newUid(): string {
  return crypto.randomUUID()
}

export function emptyGroupCondition(): UiEventGroupCondition {
  return { _uid: newUid(), field: 'event_name', pattern: '' }
}

export function emptyGroupRule(): UiEventGroupRule {
  return {
    _uid: newUid(),
    name: '',
    condition_logic: 'all',
    conditions: [emptyGroupCondition()],
  }
}

export function withUiIds(rules: EventGroupRule[]): UiEventGroupRule[] {
  return rules.map(rule => ({
    ...rule,
    _uid: newUid(),
    conditions: rule.conditions.map(condition => ({ ...condition, _uid: newUid() })),
  }))
}

export function stripUiIds(rules: UiEventGroupRule[]): EventGroupRule[] {
  return rules.map(rule => ({
    name: rule.name,
    condition_logic: rule.condition_logic,
    conditions: rule.conditions.map(condition => ({
      field: condition.field,
      pattern: condition.pattern,
    })),
  }))
}
