import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { metricsApi } from '@/api/metrics'
import type { EventListItem, MonitoringSignal } from '@/types'

import {
  EMPTY_EVENT_WINDOW_METRICS,
  ROW_METRICS_RANGE_HOURS,
  deriveRowSignalFromMetrics,
} from './utils'

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
  const eventIdsForWindowMetricsKey = useMemo(
    () => [...eventIdsForWindowMetrics].sort().join(','),
    [eventIdsForWindowMetrics],
  )

  const eventWindowMetricsQuery = useQuery({
    queryKey: [
      'eventWindowMetrics',
      slug,
      eventIdsForWindowMetricsKey,
      rowMetricsRange.time_from,
      rowMetricsRange.time_to,
    ],
    queryFn: () => metricsApi.getEventsWindowMetrics(slug!, {
      event_ids: eventIdsForWindowMetrics,
      ...rowMetricsRange,
    }),
    enabled: !!slug && eventIdsForWindowMetrics.length > 0,
    refetchInterval: 60000,
  })
  const eventWindowMetrics = eventWindowMetricsQuery.data ?? EMPTY_EVENT_WINDOW_METRICS

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
