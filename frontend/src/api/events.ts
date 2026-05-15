import { api } from './client'
import type { Event, EventListResponse } from '../types'

export const eventsApi = {
  list: (slug: string, params?: { event_type_id?: string; search?: string; implemented?: boolean; reviewed?: boolean; archived?: boolean; tag?: string; silent_since_days?: number; offset?: number; limit?: number }) => {
    const sp = new URLSearchParams()
    if (params?.event_type_id) sp.set('event_type_id', params.event_type_id)
    if (params?.search) sp.set('search', params.search)
    if (params?.implemented !== undefined) sp.set('implemented', String(params.implemented))
    if (params?.reviewed !== undefined) sp.set('reviewed', String(params.reviewed))
    if (params?.archived !== undefined) sp.set('archived', String(params.archived))
    if (params?.tag) sp.set('tag', params.tag)
    if (params?.silent_since_days !== undefined) sp.set('silent_since_days', String(params.silent_since_days))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    return api.get<EventListResponse>(`/projects/${slug}/events${qs ? `?${qs}` : ''}`)
  },
  tags: (slug: string) => api.get<string[]>(`/projects/${slug}/events/tags`),
  get: (slug: string, id: string) => api.get<Event>(`/projects/${slug}/events/${id}`),
  create: (slug: string, data: {
    event_type_id: string; name: string; description?: string;
    implemented?: boolean; reviewed?: boolean; tags?: string[];
    field_values?: { field_definition_id: string; value: string }[];
    meta_values?: { meta_field_definition_id: string; value: string }[];
  }) => api.post<Event>(`/projects/${slug}/events`, data),
  update: (slug: string, id: string, data: {
    name?: string; description?: string;
    implemented?: boolean; reviewed?: boolean; archived?: boolean; tags?: string[];
    field_values?: { field_definition_id: string; value: string }[];
    meta_values?: { meta_field_definition_id: string; value: string }[];
  }) => api.patch<Event>(`/projects/${slug}/events/${id}`, data),
  del: (slug: string, id: string) => api.del(`/projects/${slug}/events/${id}`),
  bulkCreate: (slug: string, data: {
    event_type_id: string; name: string;
    field_values?: { field_definition_id: string; value: string }[];
    meta_values?: { meta_field_definition_id: string; value: string }[];
  }[]) => api.post<Event[]>(`/projects/${slug}/events/bulk`, data),
  bulkDelete: (slug: string, eventIds: string[]) =>
    api.post<void>(`/projects/${slug}/events/bulk-delete`, { event_ids: eventIds }),
  move: (slug: string, id: string, data: { direction: 'up' | 'down'; visible_event_ids?: string[] }) =>
    api.patch<Event>(`/projects/${slug}/events/${id}/move`, data),
  reorder: (slug: string, eventIds: string[]) =>
    api.patch<Event[]>(`/projects/${slug}/events/reorder`, { event_ids: eventIds }),
}
