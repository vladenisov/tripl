import type { MetricScopeType } from '@/types'

// The subset of scopes that map to a monitoring detail route / API scope.
// `metric` is the catalog-metric drilldown (its series/versions/breakdowns
// power the MonitoringDetailPage tabs). The MetricScopeType members
// schema / distribution / release_regression have no standalone detail page.
export type MonitoringScope = 'project_total' | 'event_type' | 'event' | 'metric'

/**
 * Build the canonical monitoring-detail URL for a catalog metric. Metrics are
 * not a `MetricScopeType` member (anomaly signals never carry them), so they
 * get a dedicated helper instead of overloading {@link getMonitoringPath}.
 */
export function getMetricMonitoringPath(slug: string, metricId: string): string {
  return `/p/${slug}/monitoring/metric/${metricId}`
}

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
    case 'metric':
      // Catalog-metric anomalies carry scope_ref = metric_definition_id.
      return getMetricMonitoringPath(slug, signal.scope_ref)
    case 'schema':
    case 'distribution':
    case 'release_regression':
    case 'variable_value_drift':
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
    case 'metric':
      return 'metric'
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
