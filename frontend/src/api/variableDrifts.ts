import { api, withBranch } from './client'

export type VariableValueDriftStatus = 'open' | 'accepted' | 'snoozed' | 'false_positive'
export type VariableValueDriftAction = 'accept' | 'snooze' | 'false_positive' | 'reopen'
export type VariableValueDriftAcceptScope = 'global' | 'event'

export interface VariableValueDrift {
  id: string
  variable_id: string
  variable_name: string
  event_id: string
  event_name: string
  scan_config_id: string | null
  observed_values: string[]
  status: VariableValueDriftStatus
  resolution_note: string | null
  snoozed_until: string | null
  resolved_at: string | null
  resolved_by: string | null
  detected_at: string
}

export interface VariableValueDriftList {
  items: VariableValueDrift[]
  total: number
}

export const variableDriftsApi = {
  list: (
    slug: string,
    filters?: { variableId?: string; eventId?: string },
    branchId?: string | null,
  ) => {
    const params = new URLSearchParams()
    if (filters?.variableId) params.set('variable_id', filters.variableId)
    if (filters?.eventId) params.set('event_id', filters.eventId)
    const query = params.toString()
    const path = `/projects/${slug}/variables/drifts${query ? `?${query}` : ''}`
    return api.get<VariableValueDriftList>(withBranch(path, branchId))
  },
  action: (
    slug: string,
    driftId: string,
    data: {
      action: VariableValueDriftAction
      scope?: VariableValueDriftAcceptScope
      note?: string
      snoozed_until?: string
    },
    branchId?: string | null,
  ) =>
    api.post<VariableValueDrift>(
      withBranch(`/projects/${slug}/variables/drifts/${driftId}/action`, branchId),
      data,
    ),
}
