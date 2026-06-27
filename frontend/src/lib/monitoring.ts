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

/**
 * Resolves the API scope for the monitoring detail page from its route params.
 *
 * The legacy `/p/:slug/events/detail/:eventId` route carries no `:scope`
 * segment, so when `scope` is absent but an `eventId` is present we default to
 * the event scope instead of throwing. Truly-unknown scope strings still throw
 * via {@link routeScopeToApiScope}, so a malformed canonical URL fails loudly.
 */
export function resolveDetailScope(
  scope: string | undefined,
  eventId: string | undefined,
): MonitoringScope {
  if (scope === undefined && eventId) return 'event'
  return routeScopeToApiScope(scope)
}
