import { api, withBranch } from './client'

export interface VariableEventOverride {
  id: string
  variable_id: string
  event_id: string
  event_name: string
  values: string[]
}

export const variableOverridesApi = {
  list: (slug: string, variableId: string, branchId?: string | null) =>
    api.get<VariableEventOverride[]>(
      withBranch(`/projects/${slug}/variables/${variableId}/event-overrides`, branchId),
    ),
  upsert: (
    slug: string,
    variableId: string,
    eventId: string,
    values: string[],
    branchId?: string | null,
  ) =>
    api.put<VariableEventOverride>(
      withBranch(`/projects/${slug}/variables/${variableId}/event-overrides/${eventId}`, branchId),
      { values },
    ),
  del: (slug: string, variableId: string, eventId: string, branchId?: string | null) =>
    api.del(
      withBranch(`/projects/${slug}/variables/${variableId}/event-overrides/${eventId}`, branchId),
    ),
}
