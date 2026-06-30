import { describe, expect, it } from 'vitest'
import {
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
