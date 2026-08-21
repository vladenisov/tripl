import { describe, expect, it } from 'vitest'
import type { MonitoringSignal } from '@/types'
import { relativeEffect, selectSignificantSignals } from './signalMagnitude'

function signal(over: Partial<MonitoringSignal>): MonitoringSignal {
  return {
    scan_config_id: 'scan-1',
    scope_type: 'event',
    scope_ref: 'event-1',
    state: 'latest_scan',
    event_id: 'event-1',
    event_type_id: null,
    bucket: '2026-08-19T00:00:00Z',
    actual_count: 0,
    expected_count: 0,
    stddev: 0,
    z_score: 0,
    direction: 'drop',
    scope_name: 'checkout_started',
    incident_child: false,
    ...over,
  }
}

describe('relativeEffect', () => {
  it('reads the magnitude the server computed', () => {
    // The server is the only side that knows a metric series is fractional, so
    // its value wins over anything derivable here (tripl-yf8c).
    const s = signal({ scope_type: 'metric', actual_count: 0.04, expected_count: 0.12, relative_effect: 0.667 })
    expect(relativeEffect(s)).toBeCloseTo(0.667, 3)
  })

  it('falls back to the count-shaped estimate when the payload carries none', () => {
    expect(relativeEffect(signal({ actual_count: 150, expected_count: 100 }))).toBeCloseTo(0.5, 6)
  })

  it('keeps the floor in the fallback, so a quiet scope cannot outrank a busy one', () => {
    // 2 vs 0.5 expected is +300% without a floor; the floor keeps it at 1.5 so a
    // scope with essentially no traffic does not dominate the list.
    expect(relativeEffect(signal({ actual_count: 2, expected_count: 0.5 }))).toBeCloseTo(1.5, 6)
  })

  it('admits a fractional metric the fallback would have hidden', () => {
    // Same numbers, with and without the server's value: 0.08 is below the 0.5
    // bar, 0.667 is above it. This is the whole defect in one assertion.
    const withServer = signal({ scope_type: 'metric', actual_count: 0.04, expected_count: 0.12, relative_effect: 0.667 })
    const without = signal({ scope_type: 'metric', actual_count: 0.04, expected_count: 0.12 })
    expect(selectSignificantSignals([withServer])).toHaveLength(1)
    expect(selectSignificantSignals([without])).toHaveLength(0)
  })

  it('sorts by the server value, biggest first', () => {
    const small = signal({ scope_ref: 'a', relative_effect: 0.6 })
    const big = signal({ scope_ref: 'b', relative_effect: 3 })
    expect(selectSignificantSignals([small, big]).map(s => s.scope_ref)).toEqual(['b', 'a'])
  })
})
