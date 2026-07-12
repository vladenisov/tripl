import { describe, expect, it } from 'vitest'
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
    expect(byId.get('scans')).toBe('/p/acme/settings/scans')
    expect(byId.get('live-activity')).toBe('/p/acme/overview')
    expect(byId.get('metrics')).toBe('/p/acme/metrics')
    expect(byId.get('monitors')).toBe('/p/acme/monitors')
    expect(byId.get('anomalies')).toBe('/p/acme/anomalies')
    expect(byId.get('coverage')).toBe('/p/acme/coverage')
    expect(byId.get('reconciliation')).toBe('/p/acme/reconciliation')
    expect(byId.get('branches')).toBe('/p/acme/settings/branches')
    expect(byId.get('alerting')).toBe('/p/acme/settings/alerting')
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
