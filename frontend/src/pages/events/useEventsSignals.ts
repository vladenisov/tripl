import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { metricsApi } from '@/api/metrics'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { EventListItem } from '@/types'

import { EMPTY_SIGNALS, mapLatestSignals, pickLatestSignal } from './utils'

/**
 * Fetches monitoring signals for the project tabs and per-row events, and
 * derives the lookup maps the host page needs. Two queries instead of one
 * because the per-row query is keyed by the *currently visible* event ids
 * (sorted/stringified to keep the cache key stable across refetches).
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
  // queryKey wants a stable scalar — a fresh array reference on every refetch
  // would mint a new cache entry per refetch and refetch in a loop.
  const eventIdsForSignalsKey = useMemo(
    () => [...eventIdsForSignals].sort().join(','),
    [eventIdsForSignals],
  )
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const tabSignalsQuery = useQuery({
    queryKey: ['activeSignals', slug, 'tabs'],
    queryFn: () => metricsApi.getActiveSignals(slug!),
    enabled: !!slug,
    refetchInterval,
  })
  const tabSignals = tabSignalsQuery.data ?? EMPTY_SIGNALS

  const rowSignalsQuery = useQuery({
    queryKey: ['activeSignals', slug, 'rows', eventIdsForSignalsKey],
    queryFn: () => metricsApi.getActiveSignals(slug!, eventIdsForSignals),
    enabled: !!slug && eventIdsForSignals.length > 0,
    refetchInterval,
  })
  const rowSignals = rowSignalsQuery.data ?? EMPTY_SIGNALS

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
