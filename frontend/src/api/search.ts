import { api, withBranch } from './client'
import type { SearchEntityType, SearchResponse } from '../types'

type SearchParams = {
  q: string
  types?: SearchEntityType[]
  include_archived?: boolean
  limit?: number
  /** `false` skips the embedding leg: a keyword-only answer, much sooner. */
  semantic?: boolean
}

export const searchApi = {
  search: (slug: string, params: SearchParams, branchId?: string | null) => {
    const sp = new URLSearchParams()
    sp.set('q', params.q)
    params.types?.forEach(type => sp.append('types', type))
    if (params.include_archived !== undefined) {
      sp.set('include_archived', String(params.include_archived))
    }
    if (params.limit !== undefined) sp.set('limit', String(params.limit))
    if (params.semantic !== undefined) sp.set('semantic', String(params.semantic))
    return api.get<SearchResponse>(
      withBranch(`/projects/${slug}/search?${sp.toString()}`, branchId),
    )
  },
  reindex: (slug: string, branchId?: string | null) =>
    api.post<{ documents_indexed: number; embeddings_scheduled: boolean }>(
      withBranch(`/projects/${slug}/search/reindex`, branchId),
    ),
}
