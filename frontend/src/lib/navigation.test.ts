import { describe, expect, it } from 'vitest'
import { buildNavGroups, resolveNavLocation } from './navigation'

describe('buildNavGroups', () => {
  it('produces the four job-based groups in order', () => {
    const groups = buildNavGroups('demo', undefined)
    expect(groups.map((g) => g.label)).toEqual(['Plan', 'Observe', 'Govern', 'Connect'])
  })

  it('maps each item to its first-class route for the active slug', () => {
    const groups = buildNavGroups('demo', undefined)
    const hrefs = Object.fromEntries(
      groups.flatMap((g) => g.items).map((i) => [i.id, i.href]),
    )
    expect(hrefs).toMatchObject({
      events: '/p/demo/events',
      'event-types': '/p/demo/settings/event-types',
      schema: '/p/demo/settings/meta-fields',
      branches: '/p/demo/settings/branches',
      monitoring: '/p/demo/settings/monitoring',
      alerting: '/p/demo/settings/alerting',
      reconciliation: '/p/demo/reconciliation',
      audit: '/p/demo/settings/audit',
      'data-sources': '/settings/data-sources',
    })
  })

  it('derives counts and an attention tone from the project summary', () => {
    const summary = {
      event_type_count: 6,
      event_count: 2483,
      active_event_count: 2483,
      implemented_event_count: 100,
      review_pending_event_count: 8,
      archived_event_count: 12,
      variable_count: 40,
      scan_count: 5,
      alert_destination_count: 2,
      monitoring_signal_count: 3,
      latest_scan_job: null,
      latest_signal: null,
    }
    const items = buildNavGroups('demo', summary).flatMap((g) => g.items)
    const monitors = items.find((i) => i.id === 'monitoring')!
    expect(items.find((i) => i.id === 'events')!.count).toBe('2.5k')
    expect(monitors.count).toBe('3')
    expect(monitors.tone).toBe('danger')
  })

  it('omits the monitors tone when there are no active signals', () => {
    const groups = buildNavGroups('demo', undefined)
    const monitors = groups.flatMap((g) => g.items).find((i) => i.id === 'monitoring')!
    expect(monitors.count).toBeUndefined()
    expect(monitors.tone).toBeUndefined()
  })
})

describe('resolveNavLocation', () => {
  it.each([
    ['/p/demo/events', 'Plan', 'Events'],
    ['/p/demo', 'Plan', 'Events'],
    ['/p/demo/events/checkout', 'Plan', 'Events'],
    ['/p/demo/overview', 'Observe', 'Overview'],
    ['/p/demo/settings/event-types', 'Plan', 'Event types'],
    ['/p/demo/settings/meta-fields', 'Plan', 'Schema & fields'],
    ['/p/demo/settings/branches', 'Plan', 'Plan branches'],
    ['/p/demo/settings/monitoring', 'Observe', 'Monitors'],
    ['/p/demo/settings/alerting', 'Observe', 'Alerting'],
    ['/p/demo/reconciliation', 'Govern', 'Reconciliation'],
    ['/p/demo/settings/audit', 'Govern', 'Audit log'],
  ])('maps %s to %s › %s', (path, area, label) => {
    expect(resolveNavLocation('demo', path)).toEqual({ area, label })
  })

  it('returns null for routes outside the grouped nav (e.g. general settings)', () => {
    expect(resolveNavLocation('demo', '/p/demo/settings')).toBeNull()
    expect(resolveNavLocation('demo', '/p/demo/settings/general')).toBeNull()
  })
})
