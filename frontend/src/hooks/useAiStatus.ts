import { useQuery } from '@tanstack/react-query'
import { aiApi } from '@/api/ai'

/** Returns true when AI features are available for the project, false while loading or on error. */
export function useAiStatus(slug: string | null | undefined): boolean {
  const { data } = useQuery({
    queryKey: ['aiStatus', slug],
    queryFn: () => aiApi.status(slug!),
    enabled: !!slug,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  return data?.enabled ?? false
}
