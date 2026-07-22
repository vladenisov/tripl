import { api } from './client'
import type {
  AppVersionAdoptionResponse,
  AppVersionSeriesResponse,
  BreakdownTimeline,
  EventMetricBreakdownsResponse,
  EventMetricsResponse,
  DistributionDriftsResponse,
  EventWindowMetrics,
  MonitoringSignal,
  OverviewKpiSeries,
  ReleaseRegressionsResponse,
  SeasonalityHeatmap,
  TopEvent,
  TopMoverItem,
} from '../types'

export interface EventsMetricsParams {
  event_type_id?: string
  search?: string
  status?: string[]
  tag?: string
  from?: string
  to?: string
}

export const metricsApi = {
  getEventsMetrics: (slug: string, params?: EventsMetricsParams) => {
    const sp = new URLSearchParams()
    if (params?.event_type_id) sp.set('event_type_id', params.event_type_id)
    if (params?.search) sp.set('search', params.search)
    if (params?.status?.length) {
      for (const s of params.status) sp.append('status', s)
    }
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

  getActiveSignals: (slug: string, eventIds?: string[], opts?: { expanded?: boolean }) => {
    // Empty / no ids → cacheable GET. Any filter → POST body, because with
    // 500+ events we'd otherwise blow past proxy/browser query-string limits.
    if (!eventIds || eventIds.length === 0) {
      // expanded=true (AnomaliesPage) adds per-event scopes and keeps tagged
      // incident children; the other callers omit it for the collapsed rollup.
      const query = opts?.expanded ? '?expanded=true' : ''
      return api.get<MonitoringSignal[]>(`/projects/${slug}/anomalies/signals${query}`)
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

  getOverviewKpiSeries: (slug: string, days = 14) =>
    api.get<OverviewKpiSeries>(`/projects/${slug}/overview/kpi-series?days=${days}`),

  getTopEvents: (slug: string, params?: { windowHours?: number; limit?: number }) => {
    const sp = new URLSearchParams()
    if (params?.windowHours !== undefined) sp.set('window_hours', String(params.windowHours))
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    return api.get<TopEvent[]>(`/projects/${slug}/overview/top-events${qs ? `?${qs}` : ''}`)
  },

  getSeasonalityHeatmap: (
    slug: string,
    scanConfigId: string,
    params: { scope_type: string; scope_ref: string; from?: string; to?: string },
  ) => {
    const sp = new URLSearchParams({
      scope_type: params.scope_type,
      scope_ref: params.scope_ref,
    })
    if (params.from) sp.set('from', params.from)
    if (params.to) sp.set('to', params.to)
    return api.get<SeasonalityHeatmap>(
      `/projects/${slug}/scans/${scanConfigId}/seasonality?${sp.toString()}`,
    )
  },

  getBreakdownTimeline: (
    slug: string,
    scanConfigId: string,
    params: {
      scope_type: string
      scope_ref: string
      breakdown_column: string
      breakdown_value: string
      is_other?: boolean
      from?: string
      to?: string
    },
  ) => {
    const sp = new URLSearchParams({
      scope_type: params.scope_type,
      scope_ref: params.scope_ref,
      breakdown_column: params.breakdown_column,
      breakdown_value: params.breakdown_value,
    })
    if (params.is_other !== undefined) sp.set('is_other', String(params.is_other))
    if (params.from) sp.set('from', params.from)
    if (params.to) sp.set('to', params.to)
    return api.get<BreakdownTimeline>(
      `/projects/${slug}/scans/${scanConfigId}/breakdown-timeline?${sp.toString()}`,
    )
  },

  getDistributionDrifts: (
    slug: string,
    params: {
      scope_type: 'project_total' | 'event_type' | 'event'
      scope_ref: string
      scan_config_id?: string
      from?: string
      to?: string
    },
  ) => {
    const sp = new URLSearchParams({
      scope_type: params.scope_type,
      scope_ref: params.scope_ref,
    })
    if (params.scan_config_id) sp.set('scan_config_id', params.scan_config_id)
    if (params.from) sp.set('from', params.from)
    if (params.to) sp.set('to', params.to)
    return api.get<DistributionDriftsResponse>(
      `/projects/${slug}/distribution-drifts?${sp.toString()}`,
    )
  },

  getAppVersionSeries: (
    slug: string,
    scanConfigId: string,
    params?: {
      scope_type?: 'project_total' | 'event_type' | 'event'
      scope_ref?: string
      from?: string
      to?: string
    },
  ) => {
    const sp = new URLSearchParams()
    if (params?.scope_type) sp.set('scope_type', params.scope_type)
    if (params?.scope_ref) sp.set('scope_ref', params.scope_ref)
    if (params?.from) sp.set('from', params.from)
    if (params?.to) sp.set('to', params.to)
    const qs = sp.toString()
    return api.get<AppVersionSeriesResponse>(
      `/projects/${slug}/scans/${scanConfigId}/app-versions${qs ? `?${qs}` : ''}`,
    )
  },

  getAppVersionAdoption: (
    slug: string,
    scanConfigId: string,
    params?: { from?: string; to?: string },
  ) => {
    const sp = new URLSearchParams()
    if (params?.from) sp.set('from', params.from)
    if (params?.to) sp.set('to', params.to)
    const qs = sp.toString()
    return api.get<AppVersionAdoptionResponse>(
      `/projects/${slug}/scans/${scanConfigId}/version-adoption${qs ? `?${qs}` : ''}`,
    )
  },

  getReleaseRegressions: (
    slug: string,
    scanConfigId: string,
    params?: { scope_type?: 'event' | 'event_type' },
  ) => {
    const sp = new URLSearchParams()
    if (params?.scope_type) sp.set('scope_type', params.scope_type)
    const qs = sp.toString()
    return api.get<ReleaseRegressionsResponse>(
      `/projects/${slug}/scans/${scanConfigId}/release-regressions${qs ? `?${qs}` : ''}`,
    )
  },
}
