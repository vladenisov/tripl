import { describe, expect, it } from 'vitest'
import { buildNavGroups, resolveNavLocation } from './navigation'

describe('buildNavGroups', () => {
  it('produces the three job-based groups in order', () => {
    const groups = buildNavGroups('demo', undefined)
    expect(groups.map((g) => g.label)).toEqual(['Plan', 'Observe', 'Govern'])
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
      monitoring: '/p/demo/monitors',
      metrics: '/p/demo/metrics',
      anomalies: '/p/demo/anomalies',
      alerting: '/p/demo/settings/alerting',
      reconciliation: '/p/demo/reconciliation',
      coverage: '/p/demo/coverage',
      scans: '/p/demo/settings/scans',
      audit: '/p/demo/settings/audit',
    })
  })

  it('derives counts from the project summary', () => {
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
      firing_monitor_count: 0,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    }
    const items = buildNavGroups('demo', summary).flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'events')!.count).toBe('2.5k')
    expect(items.find((i) => i.id === 'variables')!.count).toBe('40')
  })

  it('binds the Monitors badge to the firing-monitor count, never the signal count (H1)', () => {
    // "Monitors" counts MONITORS in a firing state (firing_monitor_count), not the
    // open-signal population (monitoring_signal_count). Binding to the signal count
    // read "Monitors 9" next to a Monitors page showing 3 firing monitors.
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
      monitoring_signal_count: 9,
      firing_monitor_count: 3,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    }
    const monitors = buildNavGroups('demo', summary)
      .flatMap((g) => g.items)
      .find((i) => i.id === 'monitoring')!
    // Shows the firing-monitor count (3) in a danger tone — equal to the Monitors
    // page firing_count — and never the stale signal population (9).
    expect(monitors.count).toBe('3')
    expect(monitors.tone).toBe('danger')
    expect(monitors.count).not.toBe('9')
  })

  it('omits the Monitors badge when no monitors are firing (H1)', () => {
    // No firing monitors → no count and no tone (rather than a "0" badge).
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
      monitoring_signal_count: 9,
      firing_monitor_count: 0,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    }
    const withZero = buildNavGroups('demo', summary).flatMap((g) => g.items)
    const withoutSummary = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    for (const items of [withZero, withoutSummary]) {
      const monitors = items.find((i) => i.id === 'monitoring')!
      expect(monitors.count).toBeUndefined()
      expect(monitors.tone).toBeUndefined()
    }
  })

  it('binds the Anomalies badge to the open-signal count (not firing monitors)', () => {
    // Anomalies lists the raw open-signal population, so its badge uses
    // monitoring_signal_count — deliberately distinct from the Monitors badge,
    // which counts firing monitors (firing_monitor_count).
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
      monitoring_signal_count: 9,
      firing_monitor_count: 3,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    }
    const anomalies = buildNavGroups('demo', summary)
      .flatMap((g) => g.items)
      .find((i) => i.id === 'anomalies')!
    expect(anomalies.count).toBe('9')
    expect(anomalies.tone).toBe('danger')
  })

  it('omits the Anomalies badge when no signals are open', () => {
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
      monitoring_signal_count: 0,
      firing_monitor_count: 0,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    }
    const withZero = buildNavGroups('demo', summary).flatMap((g) => g.items)
    const withoutSummary = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    for (const items of [withZero, withoutSummary]) {
      const anomalies = items.find((i) => i.id === 'anomalies')!
      expect(anomalies.count).toBeUndefined()
      expect(anomalies.tone).toBeUndefined()
    }
  })

  it('surfaces Variables and Relations as Plan nav items (M6)', () => {
    const items = buildNavGroups('demo', undefined)
      .filter((g) => g.label === 'Plan')
      .flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'variables')!.href).toBe('/p/demo/settings/variables')
    expect(items.find((i) => i.id === 'relations')!.href).toBe('/p/demo/settings/relations')
  })

  it('no longer exposes a standalone Fact tables nav item', () => {
    // Fact tables now live as a tab under Metrics, not as a top-level surface.
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'fact-tables')).toBeUndefined()
    expect(items.some((i) => i.href.endsWith('/fact-tables'))).toBe(false)
  })

  it('keeps the Metrics nav item highlighted on the Fact tables tab', () => {
    // The metrics item matches /metrics*, so the Fact tables tab resolves to
    // "Observe › Metrics" rather than losing its breadcrumb.
    expect(resolveNavLocation('demo', '/p/demo/metrics/fact-tables')).toEqual({
      area: 'Observe',
      label: 'Metrics',
    })
  })

  it('activates Metrics — and not Monitors — on the metric monitoring drilldown (tripl-nxk2.3)', () => {
    // /p/:slug/monitoring/metric/:id is the catalog-metric detail page
    // (getMetricMonitoringPath). Breadcrumbs read "Metrics › Detail", so the
    // sidebar must highlight Metrics; the blanket /monitoring prefix on the
    // Monitors item used to win instead.
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    const metrics = items.find((i) => i.id === 'metrics')!
    const monitors = items.find((i) => i.id === 'monitoring')!
    const path = '/p/demo/monitoring/metric/9136d575'
    expect(metrics.match(path)).toBe(true)
    expect(monitors.match(path)).toBe(false)
  })

  it('keeps the event-type and project-total monitoring drilldowns on the Monitors item', () => {
    // The catalog-metric (/monitoring/metric/) and catalog-event
    // (/monitoring/event/) drilldowns moved to Metrics and Events respectively;
    // the event-type / project-total monitoring drilldowns still activate
    // Monitors (and never Metrics or Events).
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    const metrics = items.find((i) => i.id === 'metrics')!
    const events = items.find((i) => i.id === 'events')!
    const monitors = items.find((i) => i.id === 'monitoring')!
    for (const path of [
      '/p/demo/monitoring/event-type/et-1',
      '/p/demo/monitoring/project-total/pt-1',
    ]) {
      expect(monitors.match(path)).toBe(true)
      expect(metrics.match(path)).toBe(false)
      expect(events.match(path)).toBe(false)
    }
  })

  it('activates Events — and not Monitors — on the catalog-event monitoring drilldown (tripl-7l83.8)', () => {
    // /p/:slug/monitoring/event/:id is the catalog-event detail page
    // (getMonitoringPath, scope_type 'event'), reached from the Events catalog.
    // Breadcrumbs read "Events › Detail", so the sidebar must highlight Events;
    // the blanket /monitoring prefix on the Monitors item used to win instead.
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    const events = items.find((i) => i.id === 'events')!
    const monitors = items.find((i) => i.id === 'monitoring')!
    const path = '/p/demo/monitoring/event/evt-1'
    expect(events.match(path)).toBe(true)
    expect(monitors.match(path)).toBe(false)
    // Precision guard: the trailing slash means the event-type drilldown is NOT
    // swept into Events — it legitimately belongs to Monitors.
    expect(events.match('/p/demo/monitoring/event-type/et-1')).toBe(false)
  })
})

describe('resolveNavLocation', () => {
  it.each([
    ['/p/demo/events', 'Plan', 'Events'],
    ['/p/demo', 'Plan', 'Events'],
    ['/p/demo/events/checkout', 'Plan', 'Events'],
    ['/p/demo/monitoring/event/evt-1', 'Plan', 'Events'],
    ['/p/demo/overview', 'Observe', 'Live activity'],
    ['/p/demo/settings/event-types', 'Plan', 'Event types'],
    ['/p/demo/settings/meta-fields', 'Plan', 'Schema & fields'],
    ['/p/demo/settings/branches', 'Plan', 'Plan branches'],
    ['/p/demo/monitors', 'Observe', 'Monitors'],
    ['/p/demo/settings/monitoring', 'Observe', 'Monitors'],
    ['/p/demo/metrics', 'Observe', 'Metrics'],
    ['/p/demo/anomalies', 'Observe', 'Anomalies'],
    ['/p/demo/settings/alerting', 'Observe', 'Alerting'],
    ['/p/demo/reconciliation', 'Govern', 'Reconciliation'],
    ['/p/demo/coverage', 'Govern', 'Coverage'],
    ['/p/demo/settings/scans', 'Govern', 'Scans'],
    ['/p/demo/settings/audit', 'Govern', 'Audit log'],
  ])('maps %s to %s › %s', (path, area, label) => {
    expect(resolveNavLocation('demo', path)).toEqual({ area, label })
  })

  it('returns null for routes outside the grouped nav (e.g. general settings)', () => {
    expect(resolveNavLocation('demo', '/p/demo/settings')).toBeNull()
    expect(resolveNavLocation('demo', '/p/demo/settings/general')).toBeNull()
  })
})
