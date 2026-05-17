import { api } from './client'
import type {
  PlanDiff,
  PlanRevisionDetail,
  PlanRevisionList,
} from '../types'

export const planRevisionsApi = {
  list: (slug: string, params?: { offset?: number; limit?: number }) => {
    const sp = new URLSearchParams()
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    return api.get<PlanRevisionList>(
      `/projects/${slug}/revisions${qs ? `?${qs}` : ''}`,
    )
  },

  create: (slug: string, data: { summary?: string }) =>
    api.post<PlanRevisionDetail>(`/projects/${slug}/revisions`, data),

  get: (slug: string, revisionId: string) =>
    api.get<PlanRevisionDetail>(`/projects/${slug}/revisions/${revisionId}`),

  diff: (slug: string, revisionId: string, compareTo: string) =>
    api.get<PlanDiff>(
      `/projects/${slug}/revisions/${revisionId}/diff?compare_to=${compareTo}`,
    ),
}
