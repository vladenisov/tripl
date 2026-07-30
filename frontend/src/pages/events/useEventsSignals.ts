import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'

import { metricsApi } from '@/api/metrics'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { EventListItem } from '@/types'

import { EMPTY_SIGNALS, chunkEventIds, mapLatestSignals, pickLatestSignal } from './utils'

/**
 * Fetches monitoring signals for the project tabs and per-row events, and
 * derives the lookup maps the host page needs. Two shapes instead of one
 * because the per-row signals are keyed by the event ids they cover, bucketed
 * so an infinite-scroll append does not re-key (and re-send) the whole list.
 */
export function useEventsSignals({
  slug,
  rawEvents,
}: {
  slug: string | undefined
  rawEvents: EventListItem[]
}) {
  const eventIdsForSignals = useMemo(
    () => rawEvents.map(event => event.id),
    [rawEvents],
  )
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const tabSignalsQuery = useQuery({
    queryKey: ['activeSignals', slug, 'tabs'],
    queryFn: () => metricsApi.getActiveSignals(slug!),
    enabled: !!slug,
    refetchInterval,
  })
  const tabSignals = tabSignalsQuery.data ?? EMPTY_SIGNALS

  // Bucketed for the same reason the window-metrics query next door is
  // (tripl-jfm3.51): keying on the whole accumulated id list minted a fresh
  // cache entry on every infinite-scroll append and re-sent every id already
  // loaded, so page 12 posted 2,400 ids to learn about the 200 that were new
  // (tripl-jfm3.121). Index-aligned buckets keep each loaded bucket's key
  // stable, so an append fetches one bucket.
  const eventIdBuckets = useMemo(
    () => chunkEventIds(eventIdsForSignals),
    [eventIdsForSignals],
  )
  const rowSignals = useQueries({
    queries: eventIdBuckets.map(bucketIds => ({
      queryKey: ['activeSignals', slug, 'rows', bucketIds.join(',')],
      queryFn: () => metricsApi.getActiveSignals(slug!, bucketIds),
      enabled: !!slug && bucketIds.length > 0,
      refetchInterval,
    })),
    // Structural sharing keeps this array stable while the data is unchanged,
    // so the downstream map memo does not rebuild on every render.
    combine: results => results.flatMap(result => result.data ?? EMPTY_SIGNALS),
  })

  const projectTotalSignal = useMemo(
    () => pickLatestSignal(tabSignals, 'project_total'),
    [tabSignals],
  )
  const eventTypeSignals = useMemo(
    () => mapLatestSignals(tabSignals, 'event_type'),
    [tabSignals],
  )
  const eventSignals = useMemo(
    () => mapLatestSignals(rowSignals, 'event'),
    [rowSignals],
  )

  return {
    projectTotalSignal,
    eventTypeSignals,
    eventSignals,
  }
}
