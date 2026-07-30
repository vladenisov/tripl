import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { VirtualItem } from '@tanstack/react-virtual'

import { metricsApi } from '@/api/metrics'
import { useLiveTimeRange } from '@/hooks/useLiveTimeRange'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { EventListItem, MonitoringSignal } from '@/types'

import {
  EMPTY_EVENT_WINDOW_METRICS,
  EVENT_ID_BUCKET_SIZE,
  ROW_METRICS_RANGE_HOURS,
  chunkEventIds,
  deriveRowSignalFromMetrics,
} from './utils'

// Bucketing (chunkEventIds) lives in ./utils — the signals hook next door needs
// the identical scheme, and having two copies is how one of them drifts.
/**
 * Inclusive bucket range covering the rows the virtualizer is actually
 * rendering. Only these buckets get a query: window-metrics is the dominant
 * cost of the events page (2 calls, ~103 KB, up to 4.5 s against a 200-row
 * first page) and every bucket also carries its own refresh timer, so a user
 * who scrolled through 2.4k events accumulated ~24 recurring multi-second
 * requests in the degraded/polling fallback (tripl-jfm3.51).
 *
 * Falls back to bucket 0 alone when the virtualizer has no items yet — either
 * the list is short enough not to virtualize (≤ VIRTUAL_THRESHOLD rows, which
 * is a single bucket anyway) or it has not measured its scroll element yet, in
 * which case the user is at the top of the list.
 */
export function visibleBucketRange(virtualItems: readonly VirtualItem[]): {
  first: number
  last: number
} {
  const firstItem = virtualItems[0]
  const lastItem = virtualItems[virtualItems.length - 1]
  if (!firstItem || !lastItem) return { first: 0, last: 0 }
  return {
    first: Math.floor(firstItem.index / EVENT_ID_BUCKET_SIZE),
    last: Math.floor(lastItem.index / EVENT_ID_BUCKET_SIZE),
  }
}

/**
 * Per-row 48h sparkline metrics + derived monitoring signal: combines the
 * server-active signals (from useEventsSignals) with locally-derived signals
 * from the window-metrics query so each row gets the freshest available
 * indicator.
 */
export function useEventRowMetrics({
  slug,
  events,
  eventSignals,
  virtualItems,
}: {
  slug: string | undefined
  events: EventListItem[]
  eventSignals: Map<string, MonitoringSignal>
  /** Rows the table is currently rendering; empty when not virtualizing. */
  virtualItems: readonly VirtualItem[]
}) {
  // The memo had NO dependencies, so this window froze for the entire life of
  // the Events page: sparklines kept re-requesting the hours around whenever the
  // page was opened, however long it stayed open (tripl-jfm3.114).
  const liveRange = useLiveTimeRange(ROW_METRICS_RANGE_HOURS * 60 * 60 * 1000)
  const rowMetricsRange = useMemo(
    () => ({ time_from: liveRange.from, time_to: liveRange.to }),
    [liveRange],
  )

  const eventIdsForWindowMetrics = useMemo(
    () => events.map(event => event.id),
    [events],
  )
  const eventIdBuckets = useMemo(
    () => chunkEventIds(eventIdsForWindowMetrics),
    [eventIdsForWindowMetrics],
  )
  // Plain numbers, so the memo below only recomputes when a scroll actually
  // crosses a bucket boundary — not on every virtualizer tick.
  const { first: firstVisibleBucket, last: lastVisibleBucket } = visibleBucketRange(virtualItems)
  const visibleBuckets = useMemo(
    () =>
      eventIdBuckets.filter(
        (_bucket, index) => index >= firstVisibleBucket && index <= lastVisibleBucket,
      ),
    [eventIdBuckets, firstVisibleBucket, lastVisibleBucket],
  )
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  // `combine` runs on every render and isn't memoized by React Query, so it only
  // flattens (structural sharing keeps the array stable when data is unchanged);
  // the id→metric Map is built in a downstream useMemo keyed on that array.
  const eventWindowMetrics = useQueries({
    queries: visibleBuckets.map(bucketIds => ({
      queryKey: [
        'eventWindowMetrics',
        slug,
        bucketIds.join(','),
        rowMetricsRange.time_from,
        rowMetricsRange.time_to,
      ],
      queryFn: () => metricsApi.getEventsWindowMetrics(slug!, {
        event_ids: bucketIds,
        ...rowMetricsRange,
      }),
      enabled: !!slug && bucketIds.length > 0,
      refetchInterval,
    })),
    combine: results => results.flatMap(result => result.data ?? EMPTY_EVENT_WINDOW_METRICS),
  })

  const eventWindowMetricsByEvent = useMemo(
    () => new Map(eventWindowMetrics.map(metric => [metric.event_id, metric])),
    [eventWindowMetrics],
  )

  const eventRowSignals = useMemo(() => {
    const entries = new Map<string, MonitoringSignal>()
    for (const event of events) {
      const activeSignal = eventSignals.get(event.id)
      if (activeSignal) {
        entries.set(event.id, activeSignal)
        continue
      }
      const metric = eventWindowMetricsByEvent.get(event.id)
      const derivedSignal = deriveRowSignalFromMetrics(
        event.id,
        metric?.scan_config_id,
        metric?.data ?? [],
      )
      if (derivedSignal) {
        entries.set(event.id, derivedSignal)
      }
    }
    return entries
  }, [eventSignals, eventWindowMetricsByEvent, events])

  return {
    eventWindowMetricsByEvent,
    eventRowSignals,
  }
}
