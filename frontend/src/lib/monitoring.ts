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

/** Scopes `getMonitoringPath` can route; the rest have no detail page. */
const SCOPES_WITH_MONITORING_ROUTE = new Set<string>([
  'project_total',
  'event_type',
  'event',
  'metric',
])

/**
 * Where to look at the thing an alert fired on, or `null` when there is nowhere
 * to look.
 *
 * `getMonitoringPath` throws for the scopes with no detail route, which is right
 * for callers that must not link to a wrong page and wrong for a table cell
 * deciding whether to offer a link at all. This answers that question instead of
 * making every caller wrap it in a try.
 *
 * The event fallback matters for drift scopes: they have no route of their own,
 * but the event they were detected on does.
 */
export function getScopeMonitoringPath(
  slug: string,
  scope: { scope_type: string; scope_ref: string; event_id?: string | null },
): string | null {
  if (SCOPES_WITH_MONITORING_ROUTE.has(scope.scope_type)) {
    return getMonitoringPath(slug, {
      scope_type: scope.scope_type as MetricScopeType,
      scope_ref: scope.scope_ref,
    })
  }
  if (scope.event_id) return `/p/${slug}/monitoring/event/${scope.event_id}`
  return null
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

/** Minimal shape a signal needs for its severity label; both
 * {@link MonitoringSignal} and {@link TopMoverItem} satisfy it structurally. */
export interface SignalSeverityInput {
  actual_count: number
  expected_count: number
  z_score: number
  direction: string
}

/**
 * Human-readable severity label for a monitoring-signal cell.
 *
 * A drop that bottomed out at zero has its z-score clamped by the detector, so
 * every such signal reads an identical, low-information `z=-20.0`. The useful
 * fact is that the series went to zero, so surface "dropped to zero" instead.
 * Every other case keeps the numeric `z=X.X` (prefix included, so call sites can
 * render the return value directly without adding their own "z=").
 */
export function formatSignalSeverity(signal: SignalSeverityInput): string {
  if (signal.direction === 'drop' && signal.actual_count === 0) {
    return 'dropped to zero'
  }
  return `z=${signal.z_score.toFixed(1)}`
}
