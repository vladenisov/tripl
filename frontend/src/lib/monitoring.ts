type MonitoringScope = 'project_total' | 'event_type' | 'event'

export function getMonitoringPath(
  slug: string,
  signal: { scope_type: MonitoringScope; scope_ref: string },
) {
  if (signal.scope_type === 'project_total') {
    return `/p/${slug}/monitoring/project-total/${signal.scope_ref}`
  }
  if (signal.scope_type === 'event_type') {
    return `/p/${slug}/monitoring/event-type/${signal.scope_ref}`
  }
  return `/p/${slug}/monitoring/event/${signal.scope_ref}`
}

export function routeScopeToApiScope(scope: string | undefined) {
  if (scope === 'project-total') return 'project_total'
  if (scope === 'event-type') return 'event_type'
  return 'event'
}
