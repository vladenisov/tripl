import { api, withBranch } from './client'
import type { EventType, SchemaDriftList, Sensitivity } from '../types'

export const eventTypesApi = {
  list: (slug: string, branchId?: string | null) =>
    api.get<EventType[]>(withBranch(`/projects/${slug}/event-types`, branchId)),
  get: (slug: string, id: string, branchId?: string | null) =>
    api.get<EventType>(withBranch(`/projects/${slug}/event-types/${id}`, branchId)),
  create: (
    slug: string,
    data: {
      name: string
      display_name: string
      description?: string
      color?: string
      field_definitions?: Array<{
        name: string
        display_name: string
        field_type: string
        is_required?: boolean
        sensitivity?: Sensitivity
        contract_required_max_null_rate?: number | null
        contract_regex?: string | null
        contract_min_value?: number | null
        contract_max_value?: number | null
        contract_max_bad_rate?: number
      }>
    },
    branchId?: string | null,
  ) => api.post<EventType>(withBranch(`/projects/${slug}/event-types`, branchId), data),
  update: (
    slug: string,
    id: string,
    data: Partial<{ display_name: string; description: string; color: string; order: number }>,
    branchId?: string | null,
  ) => api.patch<EventType>(withBranch(`/projects/${slug}/event-types/${id}`, branchId), data),
  del: (slug: string, id: string, branchId?: string | null) =>
    api.del(withBranch(`/projects/${slug}/event-types/${id}`, branchId)),
  listDrifts: (slug: string, eventTypeId: string) =>
    api.get<SchemaDriftList>(`/projects/${slug}/event-types/${eventTypeId}/drifts`),
  applyDriftAction: (
    slug: string,
    driftId: string,
    data: {
      action: 'accept' | 'snooze' | 'false_positive' | 'reopen'
      note?: string | null
      snoozed_until?: string | null
    },
  ) => api.post(`/projects/${slug}/event-types/drifts/${driftId}/actions`, data),
}
