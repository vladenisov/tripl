import { afterEach, describe, expect, it } from 'vitest'
import {
  activeScenarioStep,
  buildScenarioSteps,
  initialScenarioState,
  isScenarioWatching,
  readScenarioState,
  scenarioReducer,
  scenarioStepIndex,
  writeScenarioState,
  type ScenarioState,
} from './scenarioModel'

const SLUG = 'acme'
const KEY = `tripl-demo-scenario:${SLUG}`

/** State as it looks the moment the user's run is accepted. */
function watching(): ScenarioState {
  return scenarioReducer(initialScenarioState(), {
    type: 'scanRunStarted',
    scanConfigId: 'sc-1',
    scanJobId: 'job-1',
    at: 1000,
  })
}

/** State after the run landed and a collect is in flight. */
function collecting(): ScenarioState {
  const landed = scenarioReducer(watching(), { type: 'scanSettled', outcome: 'completed' })
  return scenarioReducer(landed, { type: 'collectStarted', metricId: 'm-1', at: 2000 })
}

afterEach(() => {
  window.localStorage.clear()
})

describe('scenarioReducer — the happy chain', () => {
  it('runs scan -> watch -> collect -> chart -> completed', () => {
    const run = watching()
    expect(run.step).toBe('watch-scan')
    expect(run.scan).toEqual({ scanConfigId: 'sc-1', scanJobId: 'job-1', startedAt: 1000 })

    const landed = scenarioReducer(run, { type: 'scanSettled', outcome: 'completed' })
    expect(landed.step).toBe('collect-metric')
    // The landed run is kept — the strip links back to what it changed.
    expect(landed.scan?.scanJobId).toBe('job-1')

    const collect = scenarioReducer(landed, { type: 'collectStarted', metricId: 'm-1', at: 2000 })
    expect(collect.step).toBe('collect-metric')
    expect(collect.metric).toEqual({ metricId: 'm-1', startedAt: 2000 })

    const collected = scenarioReducer(collect, { type: 'collectSettled', outcome: 'success' })
    expect(collected.step).toBe('see-chart')

    const done = scenarioReducer(collected, { type: 'chartVisited', metricId: 'm-1' })
    expect(done.status).toBe('completed')
  })

  it('does not mutate the state it is given', () => {
    const before = watching()
    const snapshot = structuredClone(before)
    scenarioReducer(before, { type: 'scanSettled', outcome: 'completed' })
    expect(before).toEqual(snapshot)
  })
})

describe('scenarioReducer — regressions', () => {
  it('sends a failed run back to run-scan with a hint and no dead artifact', () => {
    const state = scenarioReducer(watching(), { type: 'scanSettled', outcome: 'failed' })
    expect(state).toEqual({ v: 1, status: 'active', step: 'run-scan', hint: 'scan-failed' })
  })

  it('treats a cancelled run as a failure', () => {
    const state = scenarioReducer(watching(), { type: 'scanSettled', outcome: 'cancelled' })
    expect(state.step).toBe('run-scan')
    expect(state.hint).toBe('scan-failed')
  })

  it('reports a job that vanished under a demo reset as stale', () => {
    const state = scenarioReducer(watching(), { type: 'scanSettled', outcome: 'stale' })
    expect(state.step).toBe('run-scan')
    expect(state.hint).toBe('scan-stale')
    expect(state.scan).toBeUndefined()
  })

  it('keeps a failed collect on collect-metric and drops the metric', () => {
    const state = scenarioReducer(collecting(), { type: 'collectSettled', outcome: 'error' })
    expect(state.step).toBe('collect-metric')
    expect(state.hint).toBe('collect-failed')
    expect(state.metric).toBeUndefined()
  })

  it('hands a timed-out scan watch back to run-scan', () => {
    const state = scenarioReducer(watching(), { type: 'watchTimedOut' })
    expect(state.step).toBe('run-scan')
    expect(state.hint).toBe('watch-timeout')
    expect(state.scan).toBeUndefined()
  })

  it('hands a timed-out collect watch back to collect-metric', () => {
    const state = scenarioReducer(collecting(), { type: 'watchTimedOut' })
    expect(state.step).toBe('collect-metric')
    expect(state.hint).toBe('watch-timeout')
    expect(state.metric).toBeUndefined()
  })

  it('ignores a timeout when nothing is being watched', () => {
    const idle = initialScenarioState()
    expect(scenarioReducer(idle, { type: 'watchTimedOut' })).toEqual(idle)
  })

  it('clears the hint once the user acts again', () => {
    const failed = scenarioReducer(watching(), { type: 'scanSettled', outcome: 'failed' })
    const retried = scenarioReducer(failed, {
      type: 'scanRunStarted',
      scanConfigId: 'sc-1',
      scanJobId: 'job-2',
      at: 3000,
    })
    expect(retried.hint).toBeUndefined()
    expect(retried.step).toBe('watch-scan')
  })
})

describe('scenarioReducer — artifact binding', () => {
  it('keeps the newest job when Run is fired twice in a row', () => {
    const second = scenarioReducer(watching(), {
      type: 'scanRunStarted',
      scanConfigId: 'sc-2',
      scanJobId: 'job-2',
      at: 5000,
    })
    expect(second.scan).toEqual({ scanConfigId: 'sc-2', scanJobId: 'job-2', startedAt: 5000 })
  })

  it('does not finish on some other metric chart than the one collected', () => {
    const ready = scenarioReducer(collecting(), { type: 'collectSettled', outcome: 'success' })
    const wandered = scenarioReducer(ready, { type: 'chartVisited', metricId: 'm-other' })
    expect(wandered.status).toBe('active')
    expect(wandered.step).toBe('see-chart')
  })

  it('ignores a settle for a step the scenario is no longer on', () => {
    const idle = initialScenarioState()
    expect(scenarioReducer(idle, { type: 'scanSettled', outcome: 'completed' })).toEqual(idle)
    expect(scenarioReducer(idle, { type: 'collectSettled', outcome: 'success' })).toEqual(idle)
  })
})

describe('scenarioReducer — dismiss, restart and inertness', () => {
  it('dismiss stops the scenario, and nothing but restart revives it', () => {
    const dismissed = scenarioReducer(watching(), { type: 'dismiss' })
    expect(dismissed.status).toBe('dismissed')

    // A poll resolving after the user walked away must not drag the strip back.
    const late = scenarioReducer(dismissed, { type: 'scanSettled', outcome: 'completed' })
    expect(late).toEqual(dismissed)

    expect(scenarioReducer(dismissed, { type: 'restart' })).toEqual(initialScenarioState())
  })

  it('lets a completed scenario be put away, so the success strip is not permanent', () => {
    const completed: ScenarioState = { v: 1, status: 'completed', step: 'see-chart' }
    expect(scenarioReducer(completed, { type: 'dismiss' }).status).toBe('dismissed')
  })

  it('restart from a completed scenario starts a clean chain', () => {
    const completed: ScenarioState = { v: 1, status: 'completed', step: 'see-chart' }
    expect(scenarioReducer(completed, { type: 'restart' })).toEqual({
      v: 1,
      status: 'active',
      step: 'run-scan',
    })
  })
})

describe('progress helpers', () => {
  it('reports the step index for the strip', () => {
    expect(scenarioStepIndex(initialScenarioState())).toBe(0)
    expect(scenarioStepIndex(watching())).toBe(1)
    expect(scenarioStepIndex(collecting())).toBe(2)
  })

  it('is watching only while a user-started artifact is in flight', () => {
    expect(isScenarioWatching(initialScenarioState())).toBe(false)
    expect(isScenarioWatching(watching())).toBe(true)
    expect(isScenarioWatching(collecting())).toBe(true)
    // The scan landed; nothing is being watched until the user collects.
    const landed = scenarioReducer(watching(), { type: 'scanSettled', outcome: 'completed' })
    expect(isScenarioWatching(landed)).toBe(false)
    expect(isScenarioWatching(scenarioReducer(watching(), { type: 'dismiss' }))).toBe(false)
  })
})

describe('buildScenarioSteps', () => {
  it('deep-links every step against the slug', () => {
    const steps = buildScenarioSteps(SLUG, initialScenarioState())
    expect(steps.map((s) => s.id)).toEqual(['run-scan', 'watch-scan', 'collect-metric', 'see-chart'])
    expect(steps[0].to).toBe('/p/acme/settings/scans')
    expect(steps[2].to).toBe('/p/acme/metrics')
  })

  it('points "watch it land" at the scan config that is actually running', () => {
    const steps = buildScenarioSteps(SLUG, watching())
    expect(steps[1].to).toBe('/p/acme/settings/scans/sc-1')
  })

  it('points "see the chart move" at the metric the user collected', () => {
    const ready = scenarioReducer(collecting(), { type: 'collectSettled', outcome: 'success' })
    const steps = buildScenarioSteps(SLUG, ready)
    // Resolved through the monitoring path helper, not a hand-rolled URL.
    expect(steps[3].to).toBe('/p/acme/monitoring/metric/m-1')
  })

  it('falls back to the surface index when an artifact is missing', () => {
    const steps = buildScenarioSteps(SLUG, initialScenarioState())
    expect(steps[1].to).toBe('/p/acme/settings/scans')
    expect(steps[3].to).toBe('/p/acme/metrics')
  })

  it('activeScenarioStep returns the step the scenario is on', () => {
    expect(activeScenarioStep(SLUG, watching()).id).toBe('watch-scan')
    expect(activeScenarioStep(SLUG, initialScenarioState()).id).toBe('run-scan')
  })
})

describe('persistence', () => {
  it('round-trips a state carrying both artifacts', () => {
    const ready = scenarioReducer(collecting(), { type: 'collectSettled', outcome: 'success' })
    writeScenarioState(SLUG, ready)
    expect(readScenarioState(SLUG)).toEqual(ready)
  })

  it('resumes a mid-scan watch after a reload', () => {
    writeScenarioState(SLUG, watching())
    const resumed = readScenarioState(SLUG)
    expect(resumed.step).toBe('watch-scan')
    expect(resumed.scan?.scanJobId).toBe('job-1')
    expect(isScenarioWatching(resumed)).toBe(true)
  })

  it('starts fresh when nothing is stored', () => {
    expect(readScenarioState(SLUG)).toEqual(initialScenarioState())
  })

  it.each([
    ['corrupt JSON', 'not json at all'],
    ['a future version', JSON.stringify({ v: 999, status: 'active', step: 'run-scan' })],
    ['an unknown step', JSON.stringify({ v: 1, status: 'active', step: 'teleport' })],
    ['an unknown status', JSON.stringify({ v: 1, status: 'paused', step: 'run-scan' })],
    ['an unknown hint', JSON.stringify({ v: 1, status: 'active', step: 'run-scan', hint: 'huh' })],
    [
      'a malformed scan artifact',
      JSON.stringify({ v: 1, status: 'active', step: 'watch-scan', scan: { scanJobId: 'job-1' } }),
    ],
    [
      'a malformed metric artifact',
      JSON.stringify({ v: 1, status: 'active', step: 'see-chart', metric: { metricId: 7 } }),
    ],
    ['a non-object payload', JSON.stringify('run-scan')],
  ])('reads %s as a fresh scenario', (_label, raw) => {
    window.localStorage.setItem(KEY, raw)
    expect(readScenarioState(SLUG)).toEqual(initialScenarioState())
  })

  it('keeps each project on its own scenario', () => {
    writeScenarioState(SLUG, watching())
    expect(readScenarioState('other')).toEqual(initialScenarioState())
  })
})
