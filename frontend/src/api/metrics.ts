import { api } from './client'
import type {
  EventMetricBreakdownsResponse,
  EventMetricsResponse,
  EventWindowMetrics,
  MonitoringSignal,
  TopMoverItem,
} from '../types'

export interface EventsMetricsParams {
  event_type_id?: string
  search?: string
  implemented?: boolean
  reviewed?: boolean
  archived?: boolean
  tag?: string
  from?: string
  to?: string
}

export const metricsApi = {
  getEventsMetrics: (slug: string, params?: EventsMetricsParams) => {
    const sp = new URLSearchParams()
    if (params?.event_type_id) sp.set('event_type_id', params.event_type_id)
    if (params?.search) sp.set('search', params.search)
    if (params?.implemented !== undefined) sp.set('implemented', String(params.implemented))
    if (params?.reviewed !== undefined) sp.set('reviewed', String(params.reviewed))
    if (params?.archived !== undefined) sp.set('archived', String(params.archived))
    if (params?.tag) sp.set('tag', params.tag)
    if (params?.from) sp.set('from', params.from)
    if (params?.to) sp.set('to', params.to)
    const qs = sp.toString()
    return api.get<EventMetricsResponse>(`/projects/${slug}/events-metrics${qs ? `?${qs}` : ''}`)
  },

  getProjectTotalMetrics: (
    slug: string,
    params?: { scan_config_id?: string; from?: string; to?: string },
  ) => {
    const sp = new URLSearchParams()
    if (params?.scan_config_id) sp.set('scan_config_id', params.scan_config_id)
    if (params?.from) sp.set('from', params.from)
    if (params?.to) sp.set('to', params.to)
    const qs = sp.toString()
    return api.get<EventMetricsResponse>(`/projects/${slug}/metrics/total${qs ? `?${qs}` : ''}`)
  },

  getEventMetrics: (slug: string, eventId: string, params?: { from?: string; to?: string }) => {
    const sp = new URLSearchParams()
    if (params?.from) sp.set('from', params.from)
    if (params?.to) sp.set('to', params.to)
    const qs = sp.toString()
    return api.get<EventMetricsResponse>(`/projects/${slug}/events/${eventId}/metrics${qs ? `?${qs}` : ''}`)
  },

  getEventMetricBreakdowns: (
    slug: string,
    eventId: string,
    params?: { column?: string; from?: string; to?: string },
  ) => {
    const sp = new URLSearchParams()
    if (params?.column) sp.set('column', params.column)
    if (params?.from) sp.set('from', params.from)
    if (params?.to) sp.set('to', params.to)
    const qs = sp.toString()
    return api.get<EventMetricBreakdownsResponse>(
      `/projects/${slug}/events/${eventId}/metrics/breakdowns${qs ? `?${qs}` : ''}`,
    )
  },

  getEventTypeMetrics: (slug: string, eventTypeId: string, params?: { from?: string; to?: string }) => {
    const sp = new URLSearchParams()
    if (params?.from) sp.set('from', params.from)
    if (params?.to) sp.set('to', params.to)
    const qs = sp.toString()
    return api.get<EventMetricsResponse>(`/projects/${slug}/event-types/${eventTypeId}/metrics${qs ? `?${qs}` : ''}`)
  },

  getEventsWindowMetrics: (
    slug: string,
    data: { event_ids: string[]; time_from: string; time_to: string },
  ) => api.post<EventWindowMetrics[]>(`/projects/${slug}/events/window-metrics`, data),

  getActiveSignals: (slug: string, eventIds?: string[]) => {
    // Empty / no ids → cacheable GET. Any filter → POST body, because with
    // 500+ events we'd otherwise blow past proxy/browser query-string limits.
    if (!eventIds || eventIds.length === 0) {
      return api.get<MonitoringSignal[]>(`/projects/${slug}/anomalies/signals`)
    }
    return api.post<MonitoringSignal[]>(
      `/projects/${slug}/anomalies/signals/query`,
      { event_ids: eventIds },
    )
  },

  getTopMovers: (
    slug: string,
    scanConfigId: string,
    params: { scope_type: string; scope_ref: string; bucket: string; limit?: number },
  ) => {
    const sp = new URLSearchParams({
      scope_type: params.scope_type,
      scope_ref: params.scope_ref,
      bucket: params.bucket,
    })
    if (params.limit !== undefined) sp.set('limit', String(params.limit))
    return api.get<TopMoverItem[]>(
      `/projects/${slug}/scans/${scanConfigId}/top-movers?${sp.toString()}`,
    )
  },
}
