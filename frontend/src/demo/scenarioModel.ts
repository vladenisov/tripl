/**
 * The coached demo scenario — pure model (tripl-2su6.21.1).
 *
 * The product tour deep-links to a surface and lets go. This model is the thing
 * that keeps hold: a four-step chain — run a scan, watch it land, collect a
 * metric, see the chart move — that the strip and the on-surface coach marks
 * both read from.
 *
 * The load-bearing constraint: an active demo advances itself. The runtime tick
 * (tripl-2su6.7) is constantly creating real scan jobs and real collections, so
 * "a completed job exists" says nothing about whether the *user* did anything.
 * Progress is therefore bound to artifacts the user's own action produced — the
 * ScanJob returned by their run, the metric id they collected — and a step only
 * lands when that specific artifact settles. Those ids are persisted, so a
 * reload mid-scan resumes the watch instead of losing it.
 *
 * Kept free of React so every transition is unit-testable without rendering,
 * following `tourSteps.ts` and `components/onboarding-utils.ts`.
 */

import { getMetricMonitoringPath } from '@/lib/monitoring'

export type ScenarioStepId = 'run-scan' | 'watch-scan' | 'collect-metric' | 'see-chart'

export type ScenarioStatus = 'active' | 'completed' | 'dismissed'

/** Why the scenario went backwards. Surfaced as copy, never as a silent reset. */
export type ScenarioHint = 'scan-failed' | 'scan-stale' | 'collect-failed' | 'watch-timeout'

export const SCENARIO_STEP_IDS: readonly ScenarioStepId[] = [
  'run-scan',
  'watch-scan',
  'collect-metric',
  'see-chart',
]

const SCENARIO_STATUSES: readonly ScenarioStatus[] = ['active', 'completed', 'dismissed']

const SCENARIO_HINTS: readonly ScenarioHint[] = [
  'scan-failed',
  'scan-stale',
  'collect-failed',
  'watch-timeout',
]

/** Human copy for each regression, so the strip never leaves the user guessing. */
export const SCENARIO_HINT_COPY: Record<ScenarioHint, string> = {
  'scan-failed': 'That run failed. Run the scan again to carry on.',
  'scan-stale': 'That run is gone — the demo was reset. Start with a fresh scan.',
  'collect-failed': 'That collection failed. Try collecting the metric again.',
  'watch-timeout': 'That run is taking longer than usual. Check on it, or start it again.',
}

/** The ScanJob the user's own "Run" produced — the only job this scenario trusts. */
export interface ScenarioScanArtifact {
  scanConfigId: string
  scanJobId: string
  startedAt: number
}

/** The metric the user chose to collect, and when they fired it. */
export interface ScenarioMetricArtifact {
  metricId: string
  startedAt: number
}

/**
 * The persisted shape. `v` is checked on read: an unknown version is treated as
 * unreadable rather than coerced, so a future v2 can change the shape freely.
 */
export interface ScenarioState {
  v: 1
  status: ScenarioStatus
  step: ScenarioStepId
  scan?: ScenarioScanArtifact
  metric?: ScenarioMetricArtifact
  hint?: ScenarioHint
}

export type ScenarioEvent =
  | { type: 'restart' }
  | { type: 'dismiss' }
  | { type: 'scanRunStarted'; scanConfigId: string; scanJobId: string; at: number }
  | { type: 'scanSettled'; outcome: 'completed' | 'failed' | 'cancelled' | 'stale' }
  | { type: 'collectStarted'; metricId: string; at: number }
  | { type: 'collectSettled'; outcome: 'success' | 'error' }
  | { type: 'chartVisited'; metricId: string }
  | { type: 'watchTimedOut' }

export function initialScenarioState(): ScenarioState {
  return { v: 1, status: 'active', step: 'run-scan' }
}

/** Zero-based position of the current step, for the strip's progress segments. */
export function scenarioStepIndex(state: ScenarioState): number {
  return SCENARIO_STEP_IDS.indexOf(state.step)
}

/**
 * True while an artifact the user started is still being watched. The strip
 * pulses on this; it is never true just because the demo's own tick is busy.
 */
export function isScenarioWatching(state: ScenarioState): boolean {
  if (state.status !== 'active') return false
  if (state.step === 'watch-scan') return state.scan !== undefined
  if (state.step === 'collect-metric') return state.metric !== undefined
  return false
}

/**
 * Every transition. Immutable: each case returns a new state.
 *
 * Failures never strand the user on a step that can no longer complete — they
 * regress to the action step that can be retried, drop the dead artifact, and
 * leave a hint explaining why. Nothing but `restart` acts on a scenario that is
 * finished or dismissed: a background poll resolving after the user walked away
 * must not drag the strip back onto the screen.
 */
export function scenarioReducer(state: ScenarioState, event: ScenarioEvent): ScenarioState {
  if (event.type === 'restart') return initialScenarioState()
  if (state.status !== 'active') return state

  switch (event.type) {
    case 'dismiss':
      return { ...state, status: 'dismissed' }

    case 'scanRunStarted':
      // A second run before the first lands replaces the artifact: the user is
      // watching the run they just fired, not the one they abandoned.
      return {
        v: 1,
        status: 'active',
        step: 'watch-scan',
        scan: {
          scanConfigId: event.scanConfigId,
          scanJobId: event.scanJobId,
          startedAt: event.at,
        },
      }

    case 'scanSettled': {
      if (state.step !== 'watch-scan' || !state.scan) return state
      if (event.outcome === 'completed') {
        // The scan artifact survives the step: it is the record of what landed,
        // and the strip links back to it while the user collects a metric.
        return { v: 1, status: 'active', step: 'collect-metric', scan: state.scan }
      }
      return {
        v: 1,
        status: 'active',
        step: 'run-scan',
        hint: event.outcome === 'stale' ? 'scan-stale' : 'scan-failed',
      }
    }

    case 'collectStarted':
      if (state.step !== 'collect-metric') return state
      return {
        ...state,
        metric: { metricId: event.metricId, startedAt: event.at },
        hint: undefined,
      }

    case 'collectSettled': {
      if (state.step !== 'collect-metric' || !state.metric) return state
      if (event.outcome === 'success') {
        return { v: 1, status: 'active', step: 'see-chart', scan: state.scan, metric: state.metric }
      }
      return {
        v: 1,
        status: 'active',
        step: 'collect-metric',
        scan: state.scan,
        hint: 'collect-failed',
      }
    }

    case 'chartVisited':
      // Only the chart of the metric they actually collected finishes the chain;
      // wandering onto some other metric's chart is not the payoff.
      if (state.step !== 'see-chart' || state.metric?.metricId !== event.metricId) return state
      return { ...state, status: 'completed', hint: undefined }

    case 'watchTimedOut': {
      // The run may well still be going — we simply stop claiming to be watching
      // it, and hand the user back the action they can repeat.
      if (state.step === 'watch-scan' && state.scan) {
        return { v: 1, status: 'active', step: 'run-scan', hint: 'watch-timeout' }
      }
      if (state.step === 'collect-metric' && state.metric) {
        return {
          v: 1,
          status: 'active',
          step: 'collect-metric',
          scan: state.scan,
          hint: 'watch-timeout',
        }
      }
      return state
    }
  }
}

export interface ScenarioStep {
  id: ScenarioStepId
  title: string
  /** What to do next, in one line. Shown in the strip and in the coach mark. */
  instruction: string
  /** Where the action lives. Deep links follow the persisted artifacts. */
  to: string
  ctaLabel: string
}

/**
 * The four steps, with links resolved against the artifacts collected so far:
 * "watch it land" points at the scan config that is actually running, and "see
 * the chart move" at the metric the user actually collected.
 */
export function buildScenarioSteps(slug: string, state: ScenarioState): ScenarioStep[] {
  const base = `/p/${slug}`
  const scans = `${base}/settings/scans`
  return [
    {
      id: 'run-scan',
      title: 'Run a scan',
      instruction: 'Run a scan to pull fresh volume from the demo warehouse.',
      to: scans,
      ctaLabel: 'Open Scans',
    },
    {
      id: 'watch-scan',
      title: 'Watch it land',
      instruction: 'Your scan is running. Watch it complete and see what it changed.',
      to: state.scan ? `${scans}/${state.scan.scanConfigId}` : scans,
      ctaLabel: 'Open the run',
    },
    {
      id: 'collect-metric',
      title: 'Collect a metric',
      instruction: 'Pick a metric and collect it now — the same worker a real project uses.',
      to: `${base}/metrics`,
      ctaLabel: 'Open Metrics',
    },
    {
      id: 'see-chart',
      title: 'See the chart move',
      instruction: 'Open the metric to see the point your collection just added.',
      to: state.metric ? getMetricMonitoringPath(slug, state.metric.metricId) : `${base}/metrics`,
      ctaLabel: 'Open the chart',
    },
  ]
}

export function activeScenarioStep(slug: string, state: ScenarioState): ScenarioStep {
  const steps = buildScenarioSteps(slug, state)
  return steps[scenarioStepIndex(state)] ?? steps[0]
}

const STORAGE_PREFIX = 'tripl-demo-scenario:'

function isScanArtifact(value: unknown): value is ScenarioScanArtifact {
  if (typeof value !== 'object' || value === null) return false
  const artifact = value as Record<string, unknown>
  return (
    typeof artifact.scanConfigId === 'string' &&
    typeof artifact.scanJobId === 'string' &&
    typeof artifact.startedAt === 'number'
  )
}

function isMetricArtifact(value: unknown): value is ScenarioMetricArtifact {
  if (typeof value !== 'object' || value === null) return false
  const artifact = value as Record<string, unknown>
  return typeof artifact.metricId === 'string' && typeof artifact.startedAt === 'number'
}

/**
 * Anything we cannot fully vouch for reads as a fresh scenario. A half-trusted
 * state is worse than none: a step whose artifact failed validation can never
 * complete, so the user would be coached towards a dead end.
 */
function parseScenarioState(raw: string): ScenarioState | null {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Record<string, unknown>

  if (candidate.v !== 1) return null
  if (!SCENARIO_STATUSES.includes(candidate.status as ScenarioStatus)) return null
  if (!SCENARIO_STEP_IDS.includes(candidate.step as ScenarioStepId)) return null
  if (candidate.scan !== undefined && !isScanArtifact(candidate.scan)) return null
  if (candidate.metric !== undefined && !isMetricArtifact(candidate.metric)) return null
  if (candidate.hint !== undefined && !SCENARIO_HINTS.includes(candidate.hint as ScenarioHint)) {
    return null
  }

  return {
    v: 1,
    status: candidate.status as ScenarioStatus,
    step: candidate.step as ScenarioStepId,
    ...(candidate.scan ? { scan: candidate.scan as ScenarioScanArtifact } : {}),
    ...(candidate.metric ? { metric: candidate.metric as ScenarioMetricArtifact } : {}),
    ...(candidate.hint ? { hint: candidate.hint as ScenarioHint } : {}),
  }
}

export function readScenarioState(slug: string): ScenarioState {
  if (typeof window === 'undefined') return initialScenarioState()
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${slug}`)
    if (raw === null) return initialScenarioState()
    return parseScenarioState(raw) ?? initialScenarioState()
  } catch {
    return initialScenarioState()
  }
}

export function writeScenarioState(slug: string, state: ScenarioState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${slug}`, JSON.stringify(state))
  } catch {
    /* ignore — a scenario that cannot remember its place still coaches this session */
  }
}
