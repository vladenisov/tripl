import { describe, expect, it } from 'vitest'

import { signalScopeLabel } from './signalScope'
import type { MonitoringSignal } from '@/types'

function signal(overrides: Partial<MonitoringSignal> = {}): MonitoringSignal {
  return {
    scope_type: 'event',
    scope_ref: '3f2a1b9c-0000-4000-8000-000000000000',
    direction: 'drop',
    actual_count: 10,
    expected_count: 100,
    detected_at: '2026-07-29T10:00:00Z',
    ...overrides,
  } as MonitoringSignal
}

describe('signalScopeLabel — scope kinds (tripl-jfm3.120)', () => {
  it('names project total without a ref', () => {
    expect(signalScopeLabel(signal({ scope_type: 'project_total' }))).toBe('Project total')
  })

  it.each([
    ['metric', 'Metric 3f2a1b9c'],
    ['schema_drift', 'Schema drift 3f2a1b9c'],
    ['distribution_drift', 'Distribution drift 3f2a1b9c'],
    ['variable_value_drift', 'Value drift 3f2a1b9c'],
    ['release_regression', 'Release regression 3f2a1b9c'],
  ])('does not call a %s an event', (scopeType, expected) => {
    // The top bar's copy fell through to `event ${ref}` for every scope it did
    // not handle, so these five were all announced as events once the bell
    // started reading the expanded list.
    expect(
      signalScopeLabel(signal({ scope_type: scopeType as MonitoringSignal['scope_type'] })),
    ).toBe(expected)
  })

  it('falls back to the raw scope type for a kind it has never seen', () => {
    expect(
      signalScopeLabel(signal({ scope_type: 'brand_new' as MonitoringSignal['scope_type'] })),
    ).toBe('brand_new 3f2a1b9c')
  })
})

describe('signalScopeLabel — display names', () => {
  const ref = '3f2a1b9c-0000-4000-8000-000000000000'

  it('prefers the display name when the map has one', () => {
    expect(
      signalScopeLabel(signal({ scope_type: 'event', scope_ref: ref }), {
        eventNames: new Map([[ref, 'checkout_started']]),
      }),
    ).toBe('Event · checkout_started')
  })

  it('keeps the short ref while the map is empty', () => {
    // Renders before the name lists land, and after the entity is deleted.
    expect(signalScopeLabel(signal({ scope_type: 'event', scope_ref: ref }))).toBe(
      'Event 3f2a1b9c',
    )
  })

  it('reads each scope from its own map only', () => {
    const names = new Map([[ref, 'Wrong list']])
    expect(
      signalScopeLabel(signal({ scope_type: 'metric', scope_ref: ref }), { eventNames: names }),
    ).toBe('Metric 3f2a1b9c')
    expect(
      signalScopeLabel(signal({ scope_type: 'metric', scope_ref: ref }), { metricNames: names }),
    ).toBe('Metric · Wrong list')
  })
})
