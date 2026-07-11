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

  it('makes the four metric kinds and fact tables directly discoverable', () => {
    const labels = blocks.map((block) => block.label)
    // Four metric kinds…
    expect(labels).toEqual(
      expect.arrayContaining(['Event volume', 'Fact', 'SQL', 'Event composition']),
    )
    // …plus fact tables.
    expect(labels).toContain('Fact tables')
  })

  it('links fact tables to the fact-tables surface and metric kinds to the catalog', () => {
    const byId = new Map(blocks.map((block) => [block.id, block.to]))
    expect(byId.get('fact-tables')).toBe('/p/acme/metrics/fact-tables')
    expect(byId.get('fact')).toBe('/p/acme/metrics')
    expect(byId.get('sql')).toBe('/p/acme/metrics')
    expect(byId.get('event_composition')).toBe('/p/acme/metrics')
    expect(byId.get('event-count')).toBe('/p/acme/metrics')
  })
})
