import { api } from './client'
import type {
  EventGroupRule,
  PlatformPresenceResponse,
  ScanConfig,
  ScanConfigPreview,
  ScanJob,
  ScanPreviewJob,
} from '../types'

const PREVIEW_POLL_INTERVAL_MS = 1500
const PREVIEW_POLL_TIMEOUT_MS = 5 * 60 * 1000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const scansApi = {
  list: (slug: string) =>
    api.get<ScanConfig[]>(`/projects/${slug}/scans`),

  get: (slug: string, scanId: string) =>
    api.get<ScanConfig>(`/projects/${slug}/scans/${scanId}`),

  getPlatformPresence: (slug: string, scanId: string) =>
    api.get<PlatformPresenceResponse>(`/projects/${slug}/scans/${scanId}/platform-presence`),

  create: (slug: string, data: {
    data_source_id: string
    name: string
    base_query: string
    event_type_id?: string | null
    event_type_column?: string | null
    time_column?: string | null
    event_name_format?: string | null
    json_value_paths?: string[]
    event_group_rules?: EventGroupRule[]
    metric_breakdown_columns?: string[]
    metric_breakdown_values_limit?: number | null
    distribution_drift_fields?: string[]
    cardinality_threshold?: number
    interval?: string | null
    replay_chunk_interval?: string | null
    scan_lookback_hours?: number | null
    scan_row_limit?: number | null
    metrics_row_limit?: number | null
    app_version_column?: string | null
    app_version_keep_releases?: number | null
    platform_column?: string | null
  }) => api.post<ScanConfig>(`/projects/${slug}/scans`, data),

  // Preview runs against the warehouse and can be slow, so the backend handles
  // it as a worker job: POST enqueues, then we poll until it completes.
  startPreview: (slug: string, data: {
    data_source_id: string
    base_query: string
    limit?: number
    json_value_paths?: string[]
    time_column?: string | null
    scan_lookback_hours?: number | null
    include_json_paths?: boolean
  }) => api.post<ScanPreviewJob>(`/projects/${slug}/scans/preview`, data),

  getPreviewJob: (slug: string, jobId: string) =>
    api.get<ScanPreviewJob>(`/projects/${slug}/scans/preview-jobs/${jobId}`),

  // Enqueue a preview job and poll until it resolves, returning the preview
  // payload. Rejects if the job fails or polling exceeds the timeout.
  // With include_json_paths the job discovers nested JSON keys instead, and the
  // resolved payload carries only json_columns (the "Discover JSON keys" flow).
  preview: async (slug: string, data: {
    data_source_id: string
    base_query: string
    limit?: number
    json_value_paths?: string[]
    time_column?: string | null
    scan_lookback_hours?: number | null
    include_json_paths?: boolean
  }): Promise<ScanConfigPreview> => {
    const job = await scansApi.startPreview(slug, data)
    const deadline = Date.now() + PREVIEW_POLL_TIMEOUT_MS
    let current = job
    while (current.status === 'pending' || current.status === 'running') {
      if (Date.now() > deadline) throw new Error('Preview timed out')
      await sleep(PREVIEW_POLL_INTERVAL_MS)
      current = await scansApi.getPreviewJob(slug, job.id)
    }
    if (current.status === 'failed' || !current.result_summary) {
      throw new Error(current.error_message || 'Preview failed')
    }
    return current.result_summary
  },

  update: (slug: string, scanId: string, data: {
    name?: string
    base_query?: string
    event_type_id?: string | null
    event_type_column?: string | null
    time_column?: string | null
    event_name_format?: string | null
    json_value_paths?: string[]
    event_group_rules?: EventGroupRule[]
    metric_breakdown_columns?: string[]
    metric_breakdown_values_limit?: number | null
    distribution_drift_fields?: string[]
    cardinality_threshold?: number
    interval?: string | null
    replay_chunk_interval?: string | null
    scan_lookback_hours?: number | null
    scan_row_limit?: number | null
    metrics_row_limit?: number | null
    app_version_column?: string | null
    app_version_keep_releases?: number | null
    platform_column?: string | null
  }) => api.patch<ScanConfig>(`/projects/${slug}/scans/${scanId}`, data),

  del: (slug: string, scanId: string) =>
    api.del(`/projects/${slug}/scans/${scanId}`),

  run: (slug: string, scanId: string) =>
    api.post<ScanJob>(`/projects/${slug}/scans/${scanId}/run`, {}),

  applyEventGroups: (slug: string, scanId: string) =>
    api.post<ScanJob>(`/projects/${slug}/scans/${scanId}/event-groups/apply`, {}),

  replayMetrics: (slug: string, scanId: string, data: {
    time_from: string
    time_to: string
  }) => api.post<ScanJob>(`/projects/${slug}/scans/${scanId}/metrics/replay`, data),

  listJobs: (slug: string, scanId: string) =>
    api.get<ScanJob[]>(`/projects/${slug}/scans/${scanId}/jobs`),

  getJob: (slug: string, scanId: string, jobId: string) =>
    api.get<ScanJob>(`/projects/${slug}/scans/${scanId}/jobs/${jobId}`),

  cancelJob: (slug: string, scanId: string, jobId: string) =>
    api.post<ScanJob>(`/projects/${slug}/scans/${scanId}/jobs/${jobId}/cancel`, {}),
}
