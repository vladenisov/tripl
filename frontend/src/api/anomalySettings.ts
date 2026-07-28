import { api } from './client'
import type { ProjectAnomalySettings } from '../types'

export const anomalySettingsApi = {
  get: (slug: string) =>
    api.get<ProjectAnomalySettings>(`/projects/${slug}/anomaly-settings`),

  update: (
    slug: string,
    data: Partial<{
      anomaly_detection_enabled: boolean
      detect_project_total: boolean
      detect_event_types: boolean
      detect_events: boolean
      baseline_window_buckets: number
      min_history_buckets: number
      sigma_threshold: number
      min_expected_count: number
      recent_signal_window_hours: number
      anomaly_ingestion_settling_minutes: number
    }>,
  ) => api.patch<ProjectAnomalySettings>(`/projects/${slug}/anomaly-settings`, data),
}
