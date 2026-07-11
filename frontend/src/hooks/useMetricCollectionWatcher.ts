import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import type { MetricDefinitionResponse } from '@/types'

/** How often to re-check the watched metric's persisted collection status. */
const DEFAULT_POLL_INTERVAL_MS = 3000
/**
 * Stop watching after this long. The Celery task budget is far larger (30 min
 * soft limit), so a long run is not an error — the watcher bows out with an
 * informational toast instead of spinning indefinitely.
 */
const WATCH_TIMEOUT_MS = 5 * 60_000

/** `MetricDefinition.last_collection_status` markers stamped by the backend. */
const STATUS_RUNNING = 'running'
const STATUS_ERROR = 'error'

interface WatchTarget {
  metricId: string
  displayName: string
  startedAt: number
}

export interface MetricCollectionWatcherOptions {
  /** Poll cadence override — tests only. */
  pollIntervalMs?: number
}

export interface MetricCollectionWatcher {
  /** Start watching a metric whose manual collect was just accepted (202). */
  watch: (metricId: string, displayName: string) => void
  /** True while a watched collection is still running. */
  isWatching: boolean
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
export function useMetricCollectionWatcher(
  slug: string | undefined,
  onSettled?: (metricId: string, status: 'success' | 'error') => void,
  options?: MetricCollectionWatcherOptions,
): MetricCollectionWatcher {
  const [target, setTarget] = useState<WatchTarget | null>(null)

  // Latest-callback ref so callers can pass inline closures without the poll
  // resubscribing on every render.
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  // Guards double-reporting if a poll resolves right as the watch is torn down.
  const reportedRef = useRef<number | null>(null)

  const settle = (
    watched: WatchTarget,
    definition: MetricDefinitionResponse | null,
  ): void => {
    if (reportedRef.current === watched.startedAt) return
    reportedRef.current = watched.startedAt
    setTarget(null)
    if (definition === null) {
      // Watch timeout — the run may legitimately still be going.
      toast.info(
        `"${watched.displayName}" is still collecting — the chart will update when it finishes.`,
      )
      return
    }
    if (definition.last_collection_status === STATUS_ERROR) {
      toast.error(
        definition.last_collection_error
          ? `Collection failed: ${definition.last_collection_error}`
          : 'Collection failed.',
      )
      onSettledRef.current?.(watched.metricId, 'error')
      return
    }
    toast.success(`"${watched.displayName}" collected — the chart is up to date.`)
    onSettledRef.current?.(watched.metricId, 'success')
  }

  useQuery({
    // `startedAt` keys each watch to a fresh cache entry so a previous run's
    // terminal status never short-circuits a new watch with stale data.
    queryKey: ['metric-collect-watch', slug, target?.metricId, target?.startedAt],
    enabled: Boolean(slug && target),
    refetchInterval: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    // The one-off watch entry is useless once the run settles.
    gcTime: 0,
    retry: false,
    // Terminal-state detection lives in the poll itself (an async callback, not
    // an effect): each fetch inspects the persisted status and settles the watch
    // as soon as it leaves "running".
    queryFn: async () => {
      if (!slug || !target) return null
      const definition = await metricsCatalogApi.get(slug, target.metricId)
      const status = definition.last_collection_status
      if (status === STATUS_RUNNING || status === null) {
        if (Date.now() - target.startedAt >= WATCH_TIMEOUT_MS) settle(target, null)
        return definition
      }
      settle(target, definition)
      return definition
    },
  })

  return {
    watch: (metricId, displayName) =>
      setTarget({ metricId, displayName, startedAt: Date.now() }),
    isWatching: target !== null,
  }
}
