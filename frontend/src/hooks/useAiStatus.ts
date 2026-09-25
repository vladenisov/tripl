import { useQuery } from '@tanstack/react-query'
import { aiApi } from '@/api/ai'

/**
 * Returns true when AI features are available for the project, false while
 * loading or on error.
 *
 * Cached for five minutes; saving AI instance settings invalidates
 * `['aiStatus']` (ServiceSettingsPage), so an owner who turns AI on sees it at
 * once. One retry, because a single transient failure otherwise hid every AI
 * button for the whole cache lifetime.
 */
export function useAiStatus(slug: string | null | undefined): boolean {
  const { data } = useQuery({
    queryKey: ['aiStatus', slug],
    queryFn: () => aiApi.status(slug!),
    enabled: !!slug,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })
  return data?.enabled ?? false
}
