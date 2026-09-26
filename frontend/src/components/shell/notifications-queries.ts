import { useQuery } from '@tanstack/react-query'
import { alertingApi } from '@/api/alerting'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { topbarDeliveriesKey } from '@/lib/queryKeys'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'

/**
 * The bell's five latest deliveries. Read by the trigger (its first-load
 * spinner and refresh dot) and by the lazy panel under one key, so the panel
 * opening costs no second request.
 */
export function useTopbarDeliveries(slug: string | undefined) {
  // Stream-aware fallback: the SSE invalidation map refreshes this on
  // activity.created, so poll only when the stream is down.
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })
  return useQuery({
    meta: SILENT_ERROR_META,
    queryKey: topbarDeliveriesKey(slug),
    queryFn: () => alertingApi.listDeliveries(slug!, { limit: 5 }),
    enabled: !!slug,
    refetchInterval,
    staleTime: 30_000,
  })
}

/** The bell panel's chunk (notifications-panel.tsx). */
export const loadNotificationsPanel = () => import('./notifications-panel')

/** Start fetching the panel chunk on hover or focus of the bell. */
export function preloadNotificationsPanel(): void {
  void loadNotificationsPanel().catch(() => {
    /* the lazy component retries (and recovers a stale chunk) on open */
  })
}
