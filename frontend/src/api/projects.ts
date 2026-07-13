import { api } from './client'
import type { Project } from '../types'

/** Optional half-open window (`after <= t < before`) for a danger-zone reset. */
export interface DetectionResetPeriod {
  before?: string | null
  after?: string | null
}

/** Per-table rows removed by a project-wide anomaly reset. */
export interface AnomalyResetCounts {
  metric_anomalies: number
  metric_breakdown_anomalies: number
}

/** Per-table rows removed by a project-wide drift reset. */
export interface DriftResetCounts {
  schema_drifts: number
  distribution_drifts: number
}

export const projectsApi = {
  list: () => api.get<Project[]>('/projects'),
  get: (slug: string) => api.get<Project>(`/projects/${slug}`),
  create: (data: { name: string; slug: string; description?: string }) =>
    api.post<Project>('/projects', data),
  // Demo lifecycle (tripl-2su6). Create BLOCKS ~5-8s while seeding and returns a
  // fully-ready project (201) or 500 on failure. Reset/delete are scoped to the
  // demo endpoints and permitted for the demo's creator or a workspace owner —
  // distinct from the owner-only generic DELETE /projects/{slug} (`del`).
  // Seeding a demo is the one long, blocking POST in the app — the caller passes
  // a signal so it can be timed out or cancelled instead of hanging forever.
  createDemo: (signal?: AbortSignal) => api.post<Project>('/projects/demo', {}, signal),
  resetDemo: (slug: string) => api.post<Project>(`/projects/demo/${slug}/reset`, {}),
  deleteDemo: (slug: string) => api.del(`/projects/demo/${slug}`),
  update: (slug: string, data: {
    name?: string
    slug?: string
    description?: string
    app_version_keep_releases?: number
  }) =>
    api.patch<Project>(`/projects/${slug}`, data),
  del: (slug: string) => api.del(`/projects/${slug}`),
  // Owner-only danger-zone resets: clear a whole category of detections across
  // the project within the chosen period. Destructive and irreversible.
  resetAnomalies: (slug: string, period: DetectionResetPeriod) =>
    api.post<AnomalyResetCounts>(`/projects/${slug}/danger/reset-anomalies`, period),
  resetDrifts: (slug: string, period: DetectionResetPeriod) =>
    api.post<DriftResetCounts>(`/projects/${slug}/danger/reset-drifts`, period),
}
