import type { ProjectLatestScanJob, ProjectLatestSignal } from './scans'

export interface EventTypeOwner {
  id: string
  event_type_id: string
  user_id: string
  user_email: string
  user_name: string
  granted_by: string | null
  created_at: string
}

export interface ProjectSummary {
  event_type_count: number
  event_count: number
  active_event_count: number
  implemented_event_count: number
  review_pending_event_count: number
  archived_event_count: number
  variable_count: number
  scan_count: number
  alert_destination_count: number
  monitoring_signal_count: number
  firing_monitor_count: number
  latest_scan_job: ProjectLatestScanJob | null
  latest_signal: ProjectLatestSignal | null
}

export interface Project {
  id: string
  name: string
  slug: string
  description: string
  created_at: string
  updated_at: string
  summary: ProjectSummary
}

export type ActivityItemType = 'anomaly' | 'scan' | 'alert' | 'event'
export type ActivityItemSeverity = 'high' | 'medium' | 'low'

export interface ActivityItem {
  id: string
  project_id: string
  project_slug: string
  project_name: string
  type: ActivityItemType
  severity: ActivityItemSeverity
  title: string
  detail: string
  occurred_at: string
  target_path: string | null
}
