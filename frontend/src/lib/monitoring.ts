import type { MetricScopeType } from '@/types'

// The subset of MetricScopeType that maps to a monitoring detail route /
// API scope. The other three members (schema, distribution,
// release_regression) have no standalone monitoring detail page.
export type MonitoringScope = 'project_total' | 'event_type' | 'event'

export function getMonitoringPath(
  slug: string,
  signal: { scope_type: MetricScopeType; scope_ref: string },
) {
  switch (signal.scope_type) {
    case 'project_total':
      return `/p/${slug}/monitoring/project-total/${signal.scope_ref}`
    case 'event_type':
      return `/p/${slug}/monitoring/event-type/${signal.scope_ref}`
    case 'event':
      return `/p/${slug}/monitoring/event/${signal.scope_ref}`
    case 'schema':
    case 'distribution':
    case 'release_regression':
      // These scopes have no entity-level monitoring detail route; routing
      // them to the event URL (the previous silent default) mis-renders an
      // unrelated event. Fail loudly so callers don't link to a wrong page.
      throw new Error(
        `getMonitoringPath: scope_type "${signal.scope_type}" has no monitoring detail route`,
      )
  }
}

export function routeScopeToApiScope(scope: string | undefined): MonitoringScope {
  switch (scope) {
    case 'project-total':
      return 'project_total'
    case 'event-type':
      return 'event_type'
    case 'event':
      return 'event'
    default:
      throw new Error(`routeScopeToApiScope: unknown monitoring scope "${scope}"`)
  }
}
