import { useQuery } from '@tanstack/react-query'

import { metricsApi } from '@/api/metrics'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { MonitoringSignal } from '@/types'

/**
 * The project's expanded signal list — one request, one cache entry.
 *
 * The bell, the Overview headline and the Anomalies page all need the same
 * `?expanded=true` list, and each had grown its own query key
 * (`topbarNotifications…`, `overview…`, `anomalies…`). Overview renders the top
 * bar, so that route fired the identical request twice with independent poll
 * timers, and an SSE invalidation had to name all three prefixes or leave one
 * surface stale (tripl-jfm3.119).
 *
 * The key deliberately joins the existing `['activeSignals', slug, …]` family
 * the Events page already uses, so `invalidationMap.ts` covers it with no new
 * entry.
 */
export function useExpandedSignals(
  slug: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  // Stream-aware fallback: signals.updated invalidates this key, so polling is
  // only the backstop for a dropped stream.
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })
  return useQuery<MonitoringSignal[]>({
    queryKey: ['activeSignals', slug, 'expanded'],
    queryFn: () => metricsApi.getActiveSignals(slug!, undefined, { expanded: true }),
    enabled: !!slug && enabled,
    staleTime: 30_000,
    refetchInterval,
  })
}
