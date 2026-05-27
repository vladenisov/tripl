import { api } from './client'
import type { ScanConfig, ScanConfigPreview, ScanJob } from '../types'

export const scansApi = {
  list: (slug: string) =>
    api.get<ScanConfig[]>(`/projects/${slug}/scans`),

  get: (slug: string, scanId: string) =>
    api.get<ScanConfig>(`/projects/${slug}/scans/${scanId}`),

  create: (slug: string, data: {
    data_source_id: string
    name: string
    base_query: string
    event_type_id?: string | null
    event_type_column?: string | null
    time_column?: string | null
    event_name_format?: string | null
    json_value_paths?: string[]
    metric_breakdown_columns?: string[]
    metric_breakdown_values_limit?: number | null
    distribution_drift_fields?: string[]
    cardinality_threshold?: number
    interval?: string | null
    replay_chunk_interval?: string | null
  }) => api.post<ScanConfig>(`/projects/${slug}/scans`, data),

  preview: (slug: string, data: {
    data_source_id: string
    base_query: string
    limit?: number
  }) => api.post<ScanConfigPreview>(`/projects/${slug}/scans/preview`, data),

  update: (slug: string, scanId: string, data: {
    name?: string
    base_query?: string
    event_type_id?: string | null
    event_type_column?: string | null
    time_column?: string | null
    event_name_format?: string | null
    json_value_paths?: string[]
    metric_breakdown_columns?: string[]
    metric_breakdown_values_limit?: number | null
    distribution_drift_fields?: string[]
    cardinality_threshold?: number
    interval?: string | null
    replay_chunk_interval?: string | null
  }) => api.patch<ScanConfig>(`/projects/${slug}/scans/${scanId}`, data),

  del: (slug: string, scanId: string) =>
    api.del(`/projects/${slug}/scans/${scanId}`),

  run: (slug: string, scanId: string) =>
    api.post<ScanJob>(`/projects/${slug}/scans/${scanId}/run`, {}),

  replayMetrics: (slug: string, scanId: string, data: {
    time_from: string
    time_to: string
  }) => api.post<ScanJob>(`/projects/${slug}/scans/${scanId}/metrics/replay`, data),

  listJobs: (slug: string, scanId: string) =>
    api.get<ScanJob[]>(`/projects/${slug}/scans/${scanId}/jobs`),

  getJob: (slug: string, scanId: string, jobId: string) =>
    api.get<ScanJob>(`/projects/${slug}/scans/${scanId}/jobs/${jobId}`),
}
