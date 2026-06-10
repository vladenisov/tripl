import { api, withBranch } from './client'

export type ShadowEventStatus = 'new' | 'accepted' | 'dismissed'

export interface ShadowEvent {
  id: string
  scan_config_id: string
  scan_config_name: string
  event_type_id: string | null
  event_type_name: string | null
  event_name: string
  observed_count: number
  first_seen_at: string
  last_seen_at: string
  status: ShadowEventStatus
  accepted_event_id: string | null
}

export interface ShadowEventsResponse {
  items: ShadowEvent[]
  total: number
  new_count: number
}

export interface AcceptShadowEventResponse {
  candidate_id: string
  event_id: string
  status: string
}

export interface DismissShadowEventResponse {
  candidate_id: string
  status: string
}

export interface DeadEvent {
  event_id: string
  name: string
  event_type_id: string
  event_type_name: string
  last_seen_at: string | null
  created_at: string
}

export interface DeadEventsResponse {
  items: DeadEvent[]
  total: number
  days: number
}

export interface CoverageBucket {
  bucket: string
  total_count: number
  matched_count: number
}

export interface CoverageSummary {
  total_count: number
  matched_count: number
  coverage_pct: number
}

export interface CoverageResponse {
  items: CoverageBucket[]
  summary: CoverageSummary
  days: number
}

export const reconciliationApi = {
  shadowEvents: (
    slug: string,
    params: { status?: ShadowEventStatus; limit?: number },
    branchId?: string | null,
  ) => {
    const qs = new URLSearchParams()
    if (params.status) qs.set('status', params.status)
    if (params.limit !== undefined) qs.set('limit', String(params.limit))
    const base = `/projects/${slug}/reconciliation/shadow-events`
    const path = qs.toString() ? `${base}?${qs}` : base
    return api.get<ShadowEventsResponse>(withBranch(path, branchId))
  },

  acceptShadowEvent: (
    slug: string,
    id: string,
    body: { event_type_id?: string; name?: string },
    branchId?: string | null,
  ) =>
    api.post<AcceptShadowEventResponse>(
      withBranch(`/projects/${slug}/reconciliation/shadow-events/${id}/accept`, branchId),
      body,
    ),

  dismissShadowEvent: (
    slug: string,
    id: string,
    branchId?: string | null,
  ) =>
    api.post<DismissShadowEventResponse>(
      withBranch(`/projects/${slug}/reconciliation/shadow-events/${id}/dismiss`, branchId),
    ),

  deadEvents: (slug: string, days: number) =>
    api.get<DeadEventsResponse>(`/projects/${slug}/reconciliation/dead-events?days=${days}`),

  coverage: (slug: string, days: number) =>
    api.get<CoverageResponse>(`/projects/${slug}/reconciliation/coverage?days=${days}`),
}
