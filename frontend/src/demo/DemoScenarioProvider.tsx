/**
 * The stateful home of the coached demo scenario (tripl-2su6.21.2, chapters in
 * tripl-odrj.4).
 *
 * Mounted once in Layout, so the scenario survives every navigation the chains
 * require: the scan the user started keeps being watched while they walk to
 * the metrics catalog, and a reload mid-run picks the watch back up from the
 * persisted job id.
 *
 * Completion is deliberately split by chapter:
 *
 * - live-loop keeps its own SILENT polls. The SSE stream (tripl-2su6.8) hands
 *   components no event payloads — only query invalidation — and a page's job
 *   query dies with the page, so the scenario polls the one job the user's own
 *   action produced, by id. Silent, because both metric surfaces already run
 *   `useMetricCollectionWatcher` and toast the outcome.
 * - every other chapter advances on DIRECT notifications: a route visit
 *   (`stepCompletedByPath`, checked here) or a `notifyStepCompleted` fired from
 *   the exact mutation the user performed. No polling for them.
 *
 * Nothing here trusts the demo's own runtime tick (tripl-2su6.7): it manufactures
 * real scan jobs and real collections continuously, so only the artifacts the
 * user's own action produced can move live-loop forward.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import { getMetricMonitoringPath } from '@/lib/monitoring'
import type { Project, ScanJob } from '@/types'
import {
  CoachPresenceContext,
  DemoScenarioActionsContext,
  DemoScenarioContext,
  INERT_ACTIONS,
  INERT_SCENARIO,
  type CoachPresence,
  type DemoScenarioActions,
  type DemoScenarioValue,
} from './demoScenarioContext'
import {
  activeChapterState,
  activeScenarioStep,
  buildChapterList,
  buildChapterSteps,
  initialScenarioState,
  isScenarioActive,
  isScenarioWatching,
  nextChapterId,
  readScenarioState,
  scenarioMetricArtifact,
  scenarioReducer,
  scenarioScanArtifact,
  stepCompletedByPath,
  writeScenarioState,
  type ScenarioEvent,
  type ScenarioState,
  type ScenarioStepId,
} from './scenarioModel'

/** How often to re-check the artifact the user is waiting on. */
const DEFAULT_POLL_INTERVAL_MS = 3000

/**
 * Stop claiming to watch after this long. The worker's budget is far larger, so
 * a long run is not an error — the scenario simply stops pretending it is still
 * following along and hands the user back an action they can repeat.
 */
const WATCH_TIMEOUT_MS = 5 * 60_000

/** `MetricDefinition.last_collection_status` markers stamped by the backend. */
const COLLECTION_RUNNING = 'running'
const COLLECTION_ERROR = 'error'

interface DemoScenarioProviderProps {
  /** The project in scope, or undefined outside a project route. */
  project?: Project
  /** Poll cadence override — tests only. */
  pollIntervalMs?: number
  children: ReactNode
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

function syncWatchedJob(current: ScanJob[] | undefined, job: ScanJob): ScanJob[] {
  if (!current) return [job]
  const found = current.some(candidate => candidate.id === job.id)
  return found
    ? current.map(candidate => candidate.id === job.id ? job : candidate)
    : [job, ...current]
}

export function DemoScenarioProvider({
  project,
  pollIntervalMs,
  children,
}: DemoScenarioProviderProps) {
  const slug = project?.slug
  const location = useLocation()
  const queryClient = useQueryClient()

  // A demo that is still seeding has nothing to coach yet; a project that is not
  // a demo never does. `generation_status` is absent on older payloads, where a
  // listed project is by definition already built.
  const isDemoReady =
    Boolean(project?.is_demo) && (project?.generation_status ?? 'ready') === 'ready'

  const [state, setState] = useState<ScenarioState>(() =>
    slug ? readScenarioState(slug) : initialScenarioState(),
  )
  const [hintsMuted, setHintsMuted] = useState(false)

  // Re-read when the route walks to another project. Adjusting state during
  // render (the pattern Layout already uses) rather than in an effect, so the
  // first paint of the new project never shows the previous one's step.
  const [loadedSlug, setLoadedSlug] = useState(slug)
  if (loadedSlug !== slug) {
    setLoadedSlug(slug)
    setState(slug ? readScenarioState(slug) : initialScenarioState())
    setHintsMuted(false)
  }

  const dispatch = useCallback(
    (event: ScenarioEvent) => {
      setState((prev) => {
        const next = scenarioReducer(prev, event)
        // Persisting from the updater keeps the write on the transition that
        // actually happened. The write is idempotent, so a double-invoked
        // updater (StrictMode) is harmless.
        if (next !== prev && slug) writeScenarioState(slug, next)
        return next
      })
    },
    [slug],
  )

  const running = isDemoReady && isScenarioActive(state)
  const chapter = activeChapterState(state)
  const onLiveLoop = running && state.activeChapter === 'live-loop'
  const scanTarget =
    onLiveLoop && chapter?.step === 'live-loop/watch-scan'
      ? scenarioScanArtifact(state)
      : undefined
  const metricTarget =
    onLiveLoop && chapter?.step === 'live-loop/collect-metric'
      ? scenarioMetricArtifact(state)
      : undefined

  // Watch the job the user's own run created — by id, so the tick's own jobs
  // (and any job some other tab started) are invisible to the scenario.
  useQuery({
    queryKey: ['demo-scenario-scan-watch', slug, scanTarget?.scanJobId],
    enabled: Boolean(slug && scanTarget),
    refetchInterval: pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      if (!slug || !scanTarget) return null
      try {
        const job = await scansApi.getJob(slug, scanTarget.scanConfigId, scanTarget.scanJobId)
        // The scan page renders a separate list query whose fallback polling is
        // intentionally disabled while realtime is live. Mirror this exact-job
        // response into that cache so a missed terminal SSE event cannot leave
        // the same tab showing Running after the coach has already advanced.
        const terminal =
          job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
        if (terminal) {
          const listKey = ['scanJobs', slug, scanTarget.scanConfigId] as const
          queryClient.setQueryData<ScanJob[]>(listKey, current => syncWatchedJob(current, job))
          // Populate an absent cache immediately, then refresh the complete list
          // from the now-committed backend state. This also cancels any older
          // in-flight snapshot that could otherwise land as Running afterwards.
          void queryClient.invalidateQueries({ queryKey: listKey, exact: true })
        }
        if (job.status === 'completed') dispatch({ type: 'scanSettled', outcome: 'completed' })
        else if (job.status === 'failed') dispatch({ type: 'scanSettled', outcome: 'failed' })
        else if (job.status === 'cancelled') dispatch({ type: 'scanSettled', outcome: 'cancelled' })
        else if (Date.now() - scanTarget.startedAt >= WATCH_TIMEOUT_MS) {
          dispatch({ type: 'watchTimedOut' })
        }
        return job
      } catch (error) {
        // The job is gone: the demo was reset out from under the scenario.
        if (isNotFound(error)) {
          dispatch({ type: 'scanSettled', outcome: 'stale' })
          return null
        }
        throw error
      }
    },
  })

  // The collect has no job model of its own: `POST /metrics/{id}/collect` stamps
  // the definition's `last_collection_status`, and the worker settles it. So the
  // definition is the run status.
  useQuery({
    queryKey: [
      'demo-scenario-collect-watch',
      slug,
      metricTarget?.metricId,
      metricTarget?.startedAt,
    ],
    enabled: Boolean(slug && metricTarget),
    refetchInterval: pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      if (!slug || !metricTarget) return null
      try {
        const definition = await metricsCatalogApi.get(slug, metricTarget.metricId)
        const status = definition.last_collection_status
        if (status === COLLECTION_RUNNING || status === null) {
          if (Date.now() - metricTarget.startedAt >= WATCH_TIMEOUT_MS) {
            dispatch({ type: 'watchTimedOut' })
          }
        } else if (status === COLLECTION_ERROR) {
          dispatch({ type: 'collectSettled', outcome: 'error' })
        } else {
          dispatch({ type: 'collectSettled', outcome: 'success' })
        }
        return definition
      } catch (error) {
        // The metric was deleted mid-watch — treat it as a failed collect so the
        // user is sent back to pick another one rather than left waiting.
        if (isNotFound(error)) {
          dispatch({ type: 'collectSettled', outcome: 'error' })
          return null
        }
        throw error
      }
    },
  })

  // Landing on the chart of the metric they collected is the payoff, and seeing
  // it is the whole step — so visiting completes it, exactly as visiting a
  // surface advances the tour (tripl-2su6.18).
  //
  // Checked at render rather than on a route change: the collection can settle
  // while the user is *already standing on* the chart, and no navigation would
  // follow to notice.
  const seeChartMetric =
    onLiveLoop && chapter?.step === 'live-loop/see-chart'
      ? scenarioMetricArtifact(state)
      : undefined
  const chartPath =
    slug && seeChartMetric ? getMetricMonitoringPath(slug, seeChartMetric.metricId) : null
  if (seeChartMetric && chartPath === location.pathname) {
    dispatch({ type: 'chartVisited', metricId: seeChartMetric.metricId })
  }

  // Deep-link and explore steps complete by ARRIVING somewhere. Same render-time
  // check as the chart above; the reducer advances at most one step per render,
  // and no two consecutive steps share an arrival path.
  const currentStepId = running ? chapter?.step : undefined
  if (slug && currentStepId && stepCompletedByPath(slug, currentStepId, location.pathname)) {
    // The pathname rides along so edit-event can remember which editor the
    // user opened and deep-link its later steps back into it.
    dispatch({ type: 'stepCompleted', step: currentStepId, path: location.pathname })
  }

  // Which steps have a visible coach mark mounted right now. A Set, not a
  // counter: marks for one step live on one surface and unmount together.
  const [presentSteps, setPresentSteps] = useState<ReadonlySet<ScenarioStepId>>(() => new Set())

  const reportCoachPresence = useCallback((step: ScenarioStepId, mounted: boolean) => {
    setPresentSteps((prev) => {
      if (prev.has(step) === mounted) return prev
      const next = new Set(prev)
      if (mounted) next.add(step)
      else next.delete(step)
      return next
    })
  }, [])

  const presence = useMemo<CoachPresence>(
    () => ({ present: presentSteps, report: reportCoachPresence }),
    [presentSteps, reportCoachPresence],
  )

  const actions = useMemo<DemoScenarioActions>(
    () => ({
      notifyScanRunStarted: (job) =>
        dispatch({
          type: 'scanRunStarted',
          scanConfigId: job.scan_config_id,
          scanJobId: job.id,
          at: Date.now(),
        }),
      notifyMetricCollectStarted: (metricId) =>
        dispatch({ type: 'collectStarted', metricId, at: Date.now() }),
      notifyStepCompleted: (step) => dispatch({ type: 'stepCompleted', step }),
      startChapter: (chapterId) => dispatch({ type: 'startChapter', chapter: chapterId }),
      restartChapter: (chapterId) => {
        setHintsMuted(false)
        dispatch({ type: 'restartChapter', chapter: chapterId })
      },
      dismissChapter: (chapterId) => dispatch({ type: 'dismissChapter', chapter: chapterId }),
      muteHints: () => setHintsMuted(true),
      unmuteHints: () => setHintsMuted(false),
      // Not a reducer event: this discards the persisted blob outright rather
      // than transitioning it, which is exactly what a re-seed does to the data
      // the old progress was recorded against.
      resetScenario: () => {
        setHintsMuted(false)
        const fresh = initialScenarioState()
        setState(fresh)
        if (slug) writeScenarioState(slug, fresh)
      },
    }),
    [dispatch, slug],
  )

  const value = useMemo<DemoScenarioValue>(() => {
    if (!isDemoReady || !slug) return INERT_SCENARIO
    const chapters = buildChapterList(slug, state)
    const nextId = nextChapterId(state)
    return {
      available: true,
      active: isScenarioActive(state),
      state,
      activeChapter: state.activeChapter,
      step: activeScenarioStep(slug, state),
      steps: buildChapterSteps(slug, state.activeChapter ?? 'live-loop', state),
      chapters,
      nextChapter: nextId ? (chapters.find((entry) => entry.id === nextId) ?? null) : null,
      isWatching: isScenarioWatching(state),
      hintsMuted,
    }
  }, [isDemoReady, slug, state, hintsMuted])

  return (
    <DemoScenarioContext.Provider value={value}>
      <DemoScenarioActionsContext.Provider value={isDemoReady ? actions : INERT_ACTIONS}>
        <CoachPresenceContext.Provider value={presence}>{children}</CoachPresenceContext.Provider>
      </DemoScenarioActionsContext.Provider>
    </DemoScenarioContext.Provider>
  )
}
