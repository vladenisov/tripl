import { describe, expect, it } from 'vitest'
import type { ProjectSummary } from '@/types'
import {
  buildNavGroups,
  getAlertingPath,
  resolveActivityTargetPath,
  resolveNavLocation,
} from './navigation'

/**
 * A project summary with every counter quiet, so each test states only the
 * counters it is actually about. Written as a factory rather than a literal per
 * test because the badges are bound to a growing struct — `open_incident_count`
 * is the eighth field to arrive (tripl-oxkt.16) — and a repeated literal makes
 * every addition a seven-place edit that hides which number a test cares about.
 */
function projectSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    event_type_count: 6,
    event_count: 2483,
    active_event_count: 2483,
    implemented_event_count: 100,
    review_pending_event_count: 8,
    archived_event_count: 12,
    variable_count: 40,
    scan_count: 5,
    alert_destination_count: 2,
    alert_rule_count: 0,
    monitoring_signal_count: 0,
    firing_monitor_count: 0,
    open_incident_count: 0,
    failing_scan_config_count: 0,
    latest_scan_job: null,
    latest_signal: null,
    ...overrides,
  }
}

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
      metrics: '/p/demo/metrics',
      anomalies: '/p/demo/anomalies',
      alerting: '/p/demo/settings/alerting',
      reconciliation: '/p/demo/reconciliation',
      coverage: '/p/demo/coverage',
      // Scans is a top-level operational surface, not a settings tab.
      scans: '/p/demo/scans',
      audit: '/p/demo/settings/audit',
    })
  })

  it('derives counts from the project summary', () => {
    const items = buildNavGroups('demo', projectSummary()).flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'events')!.count).toBe('2.5k')
    expect(items.find((i) => i.id === 'variables')!.count).toBe('40')
  })

  it('has no Monitors item: rules are an Alerting section, not a nav peer (tripl-89ps)', () => {
    // The item rendered the same AlertRule rows the Alerting page owned, under a
    // second noun, and badged `firing_monitor_count` beside Anomalies' signal
    // count and Alerting's incident count — three danger badges in one group for
    // one event. It is now a section of Alerting.
    const items = buildNavGroups('demo', projectSummary()).flatMap((g) => g.items)
    expect(items.find((i) => i.id === 'monitoring')).toBeUndefined()
    expect(items.map((i) => i.label)).not.toContain('Monitors')
  })

  it('leaves exactly two badged surfaces in Observe, not three', () => {
    // A firing rule already reaches the sidebar through the incident it opens,
    // so `firing_monitor_count` is deliberately unread — the firing/warning/
    // healthy rollup lives on the Monitors section, against the rules it counts.
    const summary = projectSummary({
      monitoring_signal_count: 9,
      firing_monitor_count: 3,
      open_incident_count: 52,
    })
    const observe = buildNavGroups('demo', summary).find((g) => g.label === 'Observe')!
    const badged = observe.items.filter((i) => i.count !== undefined)
    expect(badged.map((i) => i.id)).toEqual(['anomalies', 'alerting'])
  })

  it('binds the Anomalies badge to the open-signal count', () => {
    // Anomalies lists the raw open-signal population, so its badge uses
    // monitoring_signal_count — never the firing-rule count, which is a
    // different question answered on the Alerting page.
    const summary = projectSummary({ monitoring_signal_count: 9, firing_monitor_count: 3 })
    const anomalies = buildNavGroups('demo', summary)
      .flatMap((g) => g.items)
      .find((i) => i.id === 'anomalies')!
    expect(anomalies.count).toBe('9')
    expect(anomalies.tone).toBe('danger')
  })

  it('omits the Anomalies badge when no signals are open', () => {
    const withZero = buildNavGroups('demo', projectSummary()).flatMap((g) => g.items)
    const withoutSummary = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    for (const items of [withZero, withoutSummary]) {
      const anomalies = items.find((i) => i.id === 'anomalies')!
      expect(anomalies.count).toBeUndefined()
      expect(anomalies.tone).toBeUndefined()
    }
  })

  it('binds the Alerting badge to the open-incident count, never the destination count (tripl-oxkt.16)', () => {
    // The production numbers that exposed this: one telegram destination, 52
    // incidents awaiting triage. The badge read "Alerting 1", untoned, directly
    // under "Anomalies 68" in danger — so the one surface carrying a real queue
    // looked like the quietest thing in the group. Destinations are
    // configuration, not work.
    const summary = projectSummary({
      alert_destination_count: 1,
      open_incident_count: 52,
      monitoring_signal_count: 68,
    })
    const alerting = buildNavGroups('demo', summary)
      .flatMap((g) => g.items)
      .find((i) => i.id === 'alerting')!
    expect(alerting.count).toBe('52')
    expect(alerting.tone).toBe('danger')
    expect(alerting.count).not.toBe('1')
  })

  it('omits the Alerting badge when the inbox is clear, even with destinations configured', () => {
    // Nothing to triage → no count and no tone, rather than a "0" badge or a
    // badge that quietly falls back to counting destinations again.
    const summary = projectSummary({ alert_destination_count: 3, open_incident_count: 0 })
    const withZero = buildNavGroups('demo', summary).flatMap((g) => g.items)
    const withoutSummary = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    for (const items of [withZero, withoutSummary]) {
      const alerting = items.find((i) => i.id === 'alerting')!
      expect(alerting.count).toBeUndefined()
      expect(alerting.tone).toBeUndefined()
    }
  })

  it('gives Alerting the same badge treatment as the Anomalies item above it', () => {
    // The defect was a parity one — Alerting was the only backlog surface in the
    // Observe group whose badge was untoned — so assert the two agree in shape.
    const summary = projectSummary({ monitoring_signal_count: 68, open_incident_count: 52 })
    const items = buildNavGroups('demo', summary).flatMap((g) => g.items)
    const anomalies = items.find((i) => i.id === 'anomalies')!
    const alerting = items.find((i) => i.id === 'alerting')!
    expect(alerting.tone).toBe(anomalies.tone)
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

  it('activates Metrics — and not Anomalies — on the metric monitoring drilldown (tripl-nxk2.3)', () => {
    // /p/:slug/monitoring/metric/:id is the catalog-metric detail page
    // (getMetricMonitoringPath). Breadcrumbs read "Metrics › Detail", so the
    // sidebar must highlight Metrics; the blanket /monitoring prefix — carried
    // by the old Monitors item, now by Anomalies — used to win instead.
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    const metrics = items.find((i) => i.id === 'metrics')!
    const anomalies = items.find((i) => i.id === 'anomalies')!
    const path = '/p/demo/monitoring/metric/9136d575'
    expect(metrics.match(path)).toBe(true)
    expect(anomalies.match(path)).toBe(false)
  })

  it('puts the event-type and project-total drilldowns on Anomalies (tripl-89ps)', () => {
    // The catalog-metric (/monitoring/metric/) and catalog-event
    // (/monitoring/event/) drilldowns belong to Metrics and Events. What is left
    // is reached from a signal, so it belongs to Anomalies — it used to activate
    // "Monitors", a list of alert RULES these volume charts have nothing to do
    // with.
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    const metrics = items.find((i) => i.id === 'metrics')!
    const events = items.find((i) => i.id === 'events')!
    const anomalies = items.find((i) => i.id === 'anomalies')!
    for (const path of [
      '/p/demo/monitoring/event-type/et-1',
      '/p/demo/monitoring/project-total/pt-1',
    ]) {
      expect(anomalies.match(path)).toBe(true)
      expect(metrics.match(path)).toBe(false)
      expect(events.match(path)).toBe(false)
    }
  })

  it('puts the detection settings on Anomalies, which is what they tune (tripl-89ps)', () => {
    // /settings/monitoring decides what gets FLAGGED and notifies nobody, so it
    // never belonged with the rules that route the result.
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    const anomalies = items.find((i) => i.id === 'anomalies')!
    const alerting = items.find((i) => i.id === 'alerting')!
    expect(anomalies.match('/p/demo/settings/monitoring')).toBe(true)
    expect(alerting.match('/p/demo/settings/monitoring')).toBe(false)
  })

  it('keeps the per-rule detail on Alerting, which owns rules (tripl-89ps)', () => {
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    const alerting = items.find((i) => i.id === 'alerting')!
    const anomalies = items.find((i) => i.id === 'anomalies')!
    expect(alerting.match('/p/demo/monitors/rule-1')).toBe(true)
    expect(anomalies.match('/p/demo/monitors/rule-1')).toBe(false)
  })

  it('activates Events — and not Anomalies — on the catalog-event monitoring drilldown (tripl-7l83.8)', () => {
    // /p/:slug/monitoring/event/:id is the catalog-event detail page
    // (getMonitoringPath, scope_type 'event'), reached from the Events catalog.
    // Breadcrumbs read "Events › Detail", so the sidebar must highlight Events.
    const items = buildNavGroups('demo', undefined).flatMap((g) => g.items)
    const events = items.find((i) => i.id === 'events')!
    const anomalies = items.find((i) => i.id === 'anomalies')!
    const path = '/p/demo/monitoring/event/evt-1'
    expect(events.match(path)).toBe(true)
    expect(anomalies.match(path)).toBe(false)
    // Precision guard: the trailing slash means the event-type drilldown is NOT
    // swept into Events — it legitimately belongs to Anomalies.
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
    // A rule's fired history is an Alerting surface; the detection settings are
    // an Anomalies one. Both used to read "Monitors" (tripl-89ps).
    ['/p/demo/monitors/rule-1', 'Observe', 'Alerting'],
    ['/p/demo/settings/monitoring', 'Observe', 'Anomalies'],
    ['/p/demo/metrics', 'Observe', 'Metrics'],
    ['/p/demo/anomalies', 'Observe', 'Anomalies'],
    ['/p/demo/settings/alerting', 'Observe', 'Alerting'],
    ['/p/demo/reconciliation', 'Govern', 'Reconciliation'],
    ['/p/demo/coverage', 'Govern', 'Coverage'],
    ['/p/demo/scans', 'Govern', 'Scans'],
    ['/p/demo/scans/scan-1', 'Govern', 'Scans'],
    ['/p/demo/settings/audit', 'Govern', 'Audit log'],
  ])('maps %s to %s › %s', (path, area, label) => {
    expect(resolveNavLocation('demo', path)).toEqual({ area, label })
  })

  it('returns null for routes outside the grouped nav (e.g. general settings)', () => {
    expect(resolveNavLocation('demo', '/p/demo/settings')).toBeNull()
    expect(resolveNavLocation('demo', '/p/demo/settings/general')).toBeNull()
  })

  it('still resolves an alerting deep link built by getAlertingPath', () => {
    // The deep link adds a path segment and a query string; the nav item matches
    // on a prefix, so the sidebar must not lose its highlight on it.
    const path = getAlertingPath('demo', { deliveryId: 'dlv-1' })
    expect(resolveNavLocation('demo', path)).toEqual({ area: 'Observe', label: 'Alerting' })
  })
})

describe('getAlertingPath', () => {
  it('is the plain page when no anchor is supplied', () => {
    expect(getAlertingPath('demo')).toBe('/p/demo/settings/alerting')
    expect(getAlertingPath('demo', {})).toBe('/p/demo/settings/alerting')
  })

  it('puts the delivery in the path segment the page reads it from', () => {
    expect(getAlertingPath('demo', { deliveryId: 'dlv-1' })).toBe(
      '/p/demo/settings/alerting/dlv-1',
    )
  })

  it('carries the item and incident anchors as the query params the page parses', () => {
    // Same two names the alert MESSAGE uses (ALERT_AUDIT_ITEM_PARAM /
    // ALERT_INCIDENT_PARAM in worker/tasks/metrics/urls.py), so an in-app link
    // and a link out of someone's telegram history land on the same row.
    expect(
      getAlertingPath('demo', {
        deliveryId: 'dlv-1',
        itemAnchor: 'event:evt-1',
        incidentId: 'grp-1',
      }),
    ).toBe('/p/demo/settings/alerting/dlv-1?item=event%3Aevt-1&incident=grp-1')
  })

  it('carries an incident with no delivery', () => {
    // The inbox card is addressable on its own; a caller holding only the
    // incident should not be forced back to the page index.
    expect(getAlertingPath('demo', { incidentId: 'grp-1' })).toBe(
      '/p/demo/settings/alerting?incident=grp-1',
    )
  })

  it('drops anchors that are null rather than emitting empty params', () => {
    expect(
      getAlertingPath('demo', { deliveryId: null, itemAnchor: null, incidentId: null }),
    ).toBe('/p/demo/settings/alerting')
  })
})

describe('resolveActivityTargetPath', () => {
  const alertRow = {
    id: 'alert-delivery:dlv-1',
    type: 'alert' as const,
    project_slug: 'demo',
    target_path: '/p/demo/settings/alerting',
  }

  it('rebuilds the delivery deep link for an alert row (tripl-oxkt.21)', () => {
    // The backend sends the bare page, which drops the reader at the top of a
    // list of every delivery and every incident — strictly worse than the
    // telegram message the same delivery sent. The delivery id was never lost:
    // it is inside the row's own id.
    expect(resolveActivityTargetPath(alertRow)).toBe('/p/demo/settings/alerting/dlv-1')
  })

  it('builds the link against the slug carried by the row itself', () => {
    // The workspace-wide feed mixes projects, so the slug has to come from the row.
    expect(resolveActivityTargetPath({ ...alertRow, project_slug: 'other' })).toBe(
      '/p/other/settings/alerting/dlv-1',
    )
  })

  it('leaves every non-alert row on the path the backend sent', () => {
    // Guessing is how this defect started; only the alert rows are known to be
    // under-specified.
    for (const type of ['anomaly', 'scan', 'event'] as const) {
      expect(
        resolveActivityTargetPath({
          id: `${type}:1`,
          type,
          project_slug: 'demo',
          target_path: '/p/demo/anomalies',
        }),
      ).toBe('/p/demo/anomalies')
    }
  })

  it('keeps the backend path when an alert row is not shaped as expected', () => {
    // A differently-minted id, or a prefix with nothing after it, means we do not
    // actually know the delivery — fall back rather than build /alerting/.
    expect(
      resolveActivityTargetPath({ ...alertRow, id: 'alert:dlv-1' }),
    ).toBe('/p/demo/settings/alerting')
    expect(
      resolveActivityTargetPath({ ...alertRow, id: 'alert-delivery:' }),
    ).toBe('/p/demo/settings/alerting')
  })

  it('stays null when the backend sent no path and the row cannot be repaired', () => {
    expect(
      resolveActivityTargetPath({ ...alertRow, id: 'alert:dlv-1', target_path: null }),
    ).toBeNull()
  })
})
