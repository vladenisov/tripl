import { api, withBranch } from './client'
import type { EventType, SchemaDriftList } from '../types'

export const eventTypesApi = {
  list: (slug: string, branchId?: string | null) =>
    api.get<EventType[]>(withBranch(`/projects/${slug}/event-types`, branchId)),
  get: (slug: string, id: string, branchId?: string | null) =>
    api.get<EventType>(withBranch(`/projects/${slug}/event-types/${id}`, branchId)),
  create: (
    slug: string,
    data: { name: string; display_name: string; description?: string; color?: string },
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
}
