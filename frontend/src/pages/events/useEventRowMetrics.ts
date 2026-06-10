import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'

import { metricsApi } from '@/api/metrics'
import type { EventListItem, MonitoringSignal } from '@/types'

import {
  EMPTY_EVENT_WINDOW_METRICS,
  ROW_METRICS_RANGE_HOURS,
  deriveRowSignalFromMetrics,
} from './utils'

// Window metrics are fetched in fixed-size, index-aligned buckets rather than as
// one query over every accumulated id. With 200-row pages + infinite scroll, a
// single all-ids query key changed on every page append and refetched metrics
// for the ENTIRE accumulated set (and the 60s interval re-pulled all of them).
// Bucketing keeps each already-loaded bucket's key stable, so appending a page
// only fetches the new bucket(s); every bucket still auto-refreshes on its own
// interval, and results merge into one event-id → metric map (unchanged shape).
const WINDOW_METRICS_BUCKET_SIZE = 100

function chunkEventIds(eventIds: string[]): string[][] {
  const buckets: string[][] = []
  for (let start = 0; start < eventIds.length; start += WINDOW_METRICS_BUCKET_SIZE) {
    buckets.push(eventIds.slice(start, start + WINDOW_METRICS_BUCKET_SIZE))
  }
  return buckets
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
}: {
  slug: string | undefined
  events: EventListItem[]
  eventSignals: Map<string, MonitoringSignal>
}) {
  const rowMetricsRange = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - ROW_METRICS_RANGE_HOURS * 60 * 60 * 1000)
    return { time_from: from.toISOString(), time_to: to.toISOString() }
  }, [])

  const eventIdsForWindowMetrics = useMemo(
    () => events.map(event => event.id),
    [events],
  )
  const eventIdBuckets = useMemo(
    () => chunkEventIds(eventIdsForWindowMetrics),
    [eventIdsForWindowMetrics],
  )

  // `combine` runs on every render and isn't memoized by React Query, so it only
  // flattens (structural sharing keeps the array stable when data is unchanged);
  // the id→metric Map is built in a downstream useMemo keyed on that array.
  const eventWindowMetrics = useQueries({
    queries: eventIdBuckets.map(bucketIds => ({
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
      refetchInterval: 60000,
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
