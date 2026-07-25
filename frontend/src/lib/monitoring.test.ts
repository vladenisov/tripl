import { describe, expect, it } from 'vitest'
import {
  formatSignalSeverity,
  getMetricMonitoringPath,
  resolveDetailScope,
  routeScopeToApiScope,
} from './monitoring'

describe('routeScopeToApiScope', () => {
  it('maps the known route scopes to their API scope', () => {
    expect(routeScopeToApiScope('project-total')).toBe('project_total')
    expect(routeScopeToApiScope('event-type')).toBe('event_type')
    expect(routeScopeToApiScope('event')).toBe('event')
    expect(routeScopeToApiScope('metric')).toBe('metric')
  })

  it('throws on truly-unknown scope strings', () => {
    expect(() => routeScopeToApiScope('bogus')).toThrow(/unknown monitoring scope/)
    expect(() => routeScopeToApiScope(undefined)).toThrow(/unknown monitoring scope/)
  })
})

describe('getMetricMonitoringPath', () => {
  it('builds the catalog-metric drilldown URL', () => {
    expect(getMetricMonitoringPath('demo', 'm-1')).toBe('/p/demo/monitoring/metric/m-1')
  })
})

describe('formatSignalSeverity', () => {
  it('reads "dropped to zero" for a drop whose actual count bottomed out at zero', () => {
    // The detector clamps the z-score for these, so "z=-20.0" is repeated and
    // low-information; the useful fact is that the series went to zero.
    expect(
      formatSignalSeverity({
        actual_count: 0,
        expected_count: 80,
        z_score: -20,
        direction: 'drop',
      }),
    ).toBe('dropped to zero')
  })

  it('keeps the numeric z-score (prefix included) for a non-zero drop', () => {
    expect(
      formatSignalSeverity({
        actual_count: 40,
        expected_count: 100,
        z_score: -6,
        direction: 'drop',
      }),
    ).toBe('z=-6.0')
  })

  it('keeps the numeric z-score for a spike, even when it reads zero actuals', () => {
    // Only a `drop` to zero gets the special label; a spike never does.
    expect(
      formatSignalSeverity({
        actual_count: 0,
        expected_count: 10,
        z_score: 4.25,
        direction: 'spike',
      }),
    ).toBe('z=4.3')
  })
})

describe('resolveDetailScope', () => {
  it('defaults to the event scope for the legacy /events/detail route (no scope segment)', () => {
    // B1: the legacy URL carries an eventId but no :scope, which used to crash.
    expect(resolveDetailScope(undefined, 'event-1')).toBe('event')
  })

  it('honours an explicit scope segment over the eventId default', () => {
    expect(resolveDetailScope('project-total', 'event-1')).toBe('project_total')
    expect(resolveDetailScope('event-type', undefined)).toBe('event_type')
  })

  it('stays strict when neither a valid scope nor an eventId is present', () => {
    expect(() => resolveDetailScope(undefined, undefined)).toThrow(/unknown monitoring scope/)
    expect(() => resolveDetailScope('bogus', undefined)).toThrow(/unknown monitoring scope/)
  })
})
