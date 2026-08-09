import { describe, expect, it } from 'vitest'
import { buildNavGroups } from '../lib/navigation'
import { buildMetricBuildingBlocks, buildTourSteps } from './tourSteps'

describe('buildTourSteps', () => {
  const steps = buildTourSteps('acme')

  it('covers every core surface named in the acceptance', () => {
    const ids = steps.map((step) => step.id)
    for (const id of [
      'events',
      'scans',
      'live-activity',
      'metrics',
      'monitors',
      'anomalies',
      'coverage',
      'reconciliation',
      'branches',
      'alerting',
    ]) {
      expect(ids).toContain(id)
    }
  })

  it('deep-links each step to the real project surface', () => {
    const byId = new Map(steps.map((step) => [step.id, step.to]))
    expect(byId.get('events')).toBe('/p/acme/events')
    expect(byId.get('scans')).toBe('/p/acme/scans')
    expect(byId.get('live-activity')).toBe('/p/acme/overview')
    expect(byId.get('metrics')).toBe('/p/acme/metrics')
    expect(byId.get('monitors')).toBe('/p/acme/monitors')
    expect(byId.get('anomalies')).toBe('/p/acme/anomalies')
    expect(byId.get('coverage')).toBe('/p/acme/coverage')
    expect(byId.get('reconciliation')).toBe('/p/acme/reconciliation')
    expect(byId.get('branches')).toBe('/p/acme/settings/branches')
    expect(byId.get('alerting')).toBe('/p/acme/settings/alerting')
  })

  it('tags every step with a nav group the sidebar actually renders (tripl-3y7z)', () => {
    // ProductTour prints `step.area` as the step's chip. The scans step said
    // 'Connect', a group buildNavGroups has never produced, so a reader who
    // dismissed the tour and went looking for "Connect → Scans" had nowhere to
    // go. Derived from navigation itself so a future rename cannot drift.
    const groups = buildNavGroups('acme', undefined).map((group) => group.label)
    for (const step of steps) {
      expect(groups, `step "${step.id}" is tagged with area "${step.area}"`).toContain(step.area)
    }
  })

  it('files the scans step under the group that owns Scans (tripl-3y7z)', () => {
    const scans = steps.find((step) => step.id === 'scans')
    const govern = buildNavGroups('acme', undefined).find((group) => group.label === 'Govern')
    expect(govern?.items.map((item) => item.id)).toContain('scans')
    expect(scans?.area).toBe('Govern')
  })

  it('describes a scan by what every run produces, not by a baseline (tripl-3y7z)', () => {
    // A scan fills the tracking plan; only a Catalog + monitoring scan records
    // metric points, and only on its schedule. "Pull recent volume from a source
    // so tripl can learn the baseline" described neither a Catalog only scan nor
    // the manual run a newcomer starts from this step.
    const scans = steps.find((step) => step.id === 'scans')
    expect(scans?.blurb).not.toMatch(/baseline/i)
    expect(scans?.blurb).toMatch(/tracking plan/i)
    expect(scans?.blurb).toMatch(/Catalog \+ monitoring/)
  })

  it('demos meaning-first search with the curated examples (tripl-odrj.5)', () => {
    const search = steps.find((step) => step.id === 'search')
    expect(search).toBeDefined()
    expect(search?.blurb).toContain('Ctrl K')
    expect(search?.blurb).toContain('⌘K')
    expect(search?.blurb).toContain('purchase funnel')
    expect(search?.blurb).toContain('money back')
    expect(search?.to).toBe('/p/acme/overview')
  })
})

describe('buildMetricBuildingBlocks', () => {
  const blocks = buildMetricBuildingBlocks('acme')

  it('covers event volume, the three catalog kinds and fact tables', () => {
    const labels = blocks.map((block) => block.label)
    expect(labels).toEqual(
      expect.arrayContaining(['Event volume', 'Fact', 'SQL', 'Event composition']),
    )
    expect(labels).toContain('Fact tables')
  })

  it('deep-links every block to the surface that actually shows it (tripl-2su6.19)', () => {
    // Every block used to point at a bare /p/acme/metrics, so the links existed
    // but discovered nothing: four of the five landed on the same unfiltered page.
    const byId = new Map(blocks.map((block) => [block.id, block.to]))

    // The three real MetricKind values open the catalog already filtered.
    expect(byId.get('fact')).toBe('/p/acme/metrics?kind=fact')
    expect(byId.get('sql')).toBe('/p/acme/metrics?kind=sql')
    expect(byId.get('event_composition')).toBe('/p/acme/metrics?kind=event_composition')

    // Event volume is not a catalog kind at all — it is the per-event series a
    // scan collects, which lives on the Events catalog.
    expect(byId.get('event-count')).toBe('/p/acme/events')

    expect(byId.get('fact-tables')).toBe('/p/acme/metrics/fact-tables')

    // No two blocks share a destination any more.
    const destinations = blocks.map((block) => block.to)
    expect(new Set(destinations).size).toBe(destinations.length)
  })
})
