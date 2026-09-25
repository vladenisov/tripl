import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import type { MetricDefinitionDetailResponse } from '@/types'
import { metricCollectWatchKey } from '@/lib/queryKeys'

/** How often to re-check the watched metric's persisted collection status. */
const DEFAULT_POLL_INTERVAL_MS = 3000
/**
 * Stop watching after this long. The Celery task budget is far larger (30 min
 * soft limit), so a long run is not an error — the watcher bows out with an
 * informational toast instead of spinning indefinitely.
 */
const WATCH_TIMEOUT_MS = 5 * 60_000
/**
 * Consecutive failed polls (5xx, network) after which the watch gives up. A
 * failing poll used to error the query, which kept refetching on the interval
 * — a global error toast every 3 s and a collect spinner that never stopped.
 */
const MAX_POLL_FAILURES = 3

/** `MetricDefinition.last_collection_status` markers stamped by the backend. */
const STATUS_RUNNING = 'running'
const STATUS_ERROR = 'error'

export interface MetricWatchRequest<TContext> {
  /**
   * The project the collect was fired against. Captured with the watch rather
   * than read live from the route: otherwise navigating to another project
   * mid-watch repointed the poll at `project-B/metric-A`, a metric that does not
   * exist there (tripl-htvg).
   */
  slug: string
  metricId: string
  displayName: string
  /**
   * Caller-supplied ids/state captured at collect-start (e.g. the route's
   * scope/scopeId). Threaded back to `onSettled` on completion so the settle
   * always acts on the metric it was actually collecting — never whatever the
   * page has since navigated to mid-watch (tripl-0s3d).
   */
  context?: TContext
}

interface WatchTarget<TContext> extends MetricWatchRequest<TContext> {
  startedAt: number
}

/** How a watch ended without the run reaching a terminal status. */
type WatchAbandoned = 'timeout' | 'missing' | 'unreachable'

export interface MetricCollectionWatcherOptions {
  /** Poll cadence override — tests only. */
  pollIntervalMs?: number
}

export interface MetricCollectionWatcher<TContext = void> {
  /**
   * Start watching a metric whose manual collect was just accepted (202). The
   * whole request — project slug included — is captured now and handed back
   * verbatim to `onSettled`.
   */
  watch: (request: MetricWatchRequest<TContext>) => void
  /** True while a watched collection is still running. */
  isWatching: boolean
  /**
   * The metric currently being watched, or `null`. Callers key their own
   * "collecting" UI to this so an in-flight watch on metric A does not render as
   * "collecting" after the page navigates to metric B (tripl-0s3d).
   */
  watchingMetricId: string | null
}

/**
 * Watches a manually-triggered metric collection until it reaches a terminal
 * state and reports the outcome as a toast.
 *
 * `POST /metrics/{id}/collect` stamps `last_collection_status="running"` before
 * it queues the Celery task, and the worker stamps `success` / `error` (plus
 * `last_collection_error`) when the run settles — the definition itself is the
 * queryable run status, so no extra job model is needed. This hook polls the
 * definition until the status leaves `running`, toasts "collected" or the
 * persisted failure reason, and calls `onSettled` so the caller can refresh its
 * series / list queries.
 */
export function useMetricCollectionWatcher<TContext = void>(
  onSettled?: (
    metricId: string,
    status: 'success' | 'error',
    context: TContext | undefined,
  ) => void,
  options?: MetricCollectionWatcherOptions,
): MetricCollectionWatcher<TContext> {
  const [target, setTarget] = useState<WatchTarget<TContext> | null>(null)

  // Latest-callback ref so callers can pass inline closures without the poll
  // resubscribing on every render.
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  // Guards double-reporting if a poll resolves right as the watch is torn down.
  const reportedRef = useRef<number | null>(null)

  // Consecutive failed polls for the current watch (reset by a good poll).
  const failuresRef = useRef(0)

  const settle = (
    watched: WatchTarget<TContext>,
    outcome: MetricDefinitionDetailResponse | WatchAbandoned,
  ): void => {
    if (reportedRef.current === watched.startedAt) return
    reportedRef.current = watched.startedAt
    setTarget(null)
    if (outcome === 'timeout') {
      // The run may legitimately still be going.
      toast.info(
        `"${watched.displayName}" is still collecting — the chart will update when it finishes.`,
      )
      return
    }
    if (outcome === 'missing') {
      toast.error(`"${watched.displayName}" no longer exists — it was deleted while collecting.`)
      return
    }
    if (outcome === 'unreachable') {
      toast.info(
        `Lost track of "${watched.displayName}" — the server stopped answering. Reload the page to see whether it finished.`,
      )
      return
    }
    const definition = outcome
    if (definition.last_collection_status === STATUS_ERROR) {
      toast.error(
        definition.last_collection_error
          ? `Collection failed: ${definition.last_collection_error}`
          : 'Collection failed.',
      )
      onSettledRef.current?.(watched.metricId, 'error', watched.context)
      return
    }
    toast.success(`"${watched.displayName}" collected — the chart is up to date.`)
    onSettledRef.current?.(watched.metricId, 'success', watched.context)
  }

  useQuery({
    // `startedAt` keys each watch to a fresh cache entry so a previous run's
    // terminal status never short-circuits a new watch with stale data. The slug
    // comes from the target, not the route, so the poll follows the collect it
    // started rather than the page the user has since walked to.
    queryKey: metricCollectWatchKey(target?.slug, target?.metricId, target?.startedAt),
    enabled: Boolean(target),
    refetchInterval: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    // The one-off watch entry is useless once the run settles.
    gcTime: 0,
    retry: false,
    // Terminal-state detection lives in the poll itself (an async callback, not
    // an effect): each fetch inspects the persisted status and settles the watch
    // as soon as it leaves "running".
    //
    // The poll never throws: every failure is counted and settled here, so no
    // error reaches the query (and its global toast) on each interval.
    queryFn: async () => {
      if (!target) return null
      // Checked before fetching, so the watch ends on time even while every
      // poll is failing.
      if (Date.now() - target.startedAt >= WATCH_TIMEOUT_MS) {
        settle(target, 'timeout')
        return null
      }
      let definition: MetricDefinitionDetailResponse
      try {
        definition = await metricsCatalogApi.get(target.slug, target.metricId)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          settle(target, 'missing')
        } else {
          failuresRef.current += 1
          if (failuresRef.current >= MAX_POLL_FAILURES) settle(target, 'unreachable')
        }
        return null
      }
      failuresRef.current = 0
      const status = definition.last_collection_status
      if (status === STATUS_RUNNING || status === null) return definition
      settle(target, definition)
      return definition
    },
  })

  return {
    watch: (request) => {
      failuresRef.current = 0
      setTarget({ ...request, startedAt: Date.now() })
    },
    isWatching: target !== null,
    watchingMetricId: target?.metricId ?? null,
  }
}
