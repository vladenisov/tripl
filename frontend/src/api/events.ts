import { api, withBranch } from './client'
import type { Event, EventChange, EventListResponse } from '../types'

type ListParams = {
  event_type_id?: string
  search?: string
  status?: string[]
  tag?: string
  silent_since_days?: number
  offset?: number
  limit?: number
}

export const eventsApi = {
  list: (slug: string, params?: ListParams, branchId?: string | null) => {
    const sp = new URLSearchParams()
    if (params?.event_type_id) sp.set('event_type_id', params.event_type_id)
    if (params?.search) sp.set('search', params.search)
    if (params?.status?.length) {
      for (const s of params.status) sp.append('status', s)
    }
    if (params?.tag) sp.set('tag', params.tag)
    if (params?.silent_since_days !== undefined) sp.set('silent_since_days', String(params.silent_since_days))
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    const path = `/projects/${slug}/events${qs ? `?${qs}` : ''}`
    return api.get<EventListResponse>(withBranch(path, branchId))
  },
  tags: (slug: string, branchId?: string | null) =>
    api.get<string[]>(withBranch(`/projects/${slug}/events/tags`, branchId)),
  get: (slug: string, id: string, branchId?: string | null) =>
    api.get<Event>(withBranch(`/projects/${slug}/events/${id}`, branchId)),
  create: (
    slug: string,
    data: {
      event_type_id: string
      name: string
      description?: string
      status?: string
      sunset_at?: string | null
      tags?: string[]
      metric_breakdown_columns?: string[]
      field_values?: { field_definition_id: string; value: string }[]
      meta_values?: { meta_field_definition_id: string; value: string }[]
    },
    branchId?: string | null,
  ) => api.post<Event>(withBranch(`/projects/${slug}/events`, branchId), data),
  update: (
    slug: string,
    id: string,
    data: {
      name?: string
      description?: string
      status?: string
      sunset_at?: string | null
      tags?: string[]
      metric_breakdown_columns?: string[]
      field_values?: { field_definition_id: string; value: string }[]
      meta_values?: { meta_field_definition_id: string; value: string }[]
    },
    branchId?: string | null,
  ) => api.patch<Event>(withBranch(`/projects/${slug}/events/${id}`, branchId), data),
  del: (slug: string, id: string, branchId?: string | null) =>
    api.del(withBranch(`/projects/${slug}/events/${id}`, branchId)),
  bulkCreate: (
    slug: string,
    data: {
      event_type_id: string
      name: string
      metric_breakdown_columns?: string[]
      field_values?: { field_definition_id: string; value: string }[]
      meta_values?: { meta_field_definition_id: string; value: string }[]
    }[],
    branchId?: string | null,
  ) => api.post<Event[]>(withBranch(`/projects/${slug}/events/bulk`, branchId), data),
  bulkDelete: (slug: string, eventIds: string[], branchId?: string | null) =>
    api.post<void>(withBranch(`/projects/${slug}/events/bulk-delete`, branchId), { event_ids: eventIds }),
  bulkUpdate: (
    slug: string,
    eventIds: string[],
    data: {
      status?: string
      sunset_at?: string | null
      reviewed?: boolean
    },
    branchId?: string | null,
  ) => api.post<void>(
    withBranch(`/projects/${slug}/events/bulk-update`, branchId),
    { event_ids: eventIds, ...data },
  ),
  move: (
    slug: string,
    id: string,
    data: { direction: 'up' | 'down'; visible_event_ids?: string[] },
    branchId?: string | null,
  ) => api.patch<Event>(withBranch(`/projects/${slug}/events/${id}/move`, branchId), data),
  reorder: (slug: string, eventIds: string[], branchId?: string | null) =>
    api.patch<Event[]>(withBranch(`/projects/${slug}/events/reorder`, branchId), { event_ids: eventIds }),
  history: (slug: string, eventId: string, branchId?: string | null) =>
    api.get<EventChange[]>(withBranch(`/projects/${slug}/events/${eventId}/history`, branchId)),
}
