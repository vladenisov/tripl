/**
 * Centralized event → query-key invalidation map (tripl-2su6.8).
 *
 * One place that maps each server event type to the set of React-Query keys that
 * must be refreshed, replacing per-widget polling. Keys are targeted by PREFIX
 * (react-query's default `invalidateQueries` match), so an entry like
 * `['scans', slug]` refreshes every query whose key starts with it
 * (`['scans', slug, ...]`). This tolerates the small divergence in existing keys
 * (some carry a sub-segment before the slug, e.g. `['overview', 'volume', slug]`)
 * without a risky rewrite of every call site: broad roots like `['overview']`
 * and `['reconciliation']` cover all their sub-keys, and only the mounted
 * project's queries exist to match.
 */

import type { QueryClient, QueryKey } from '@tanstack/react-query'

export const PROJECT_EVENT_TYPES = [
  'scan_job.updated',
  'metric_collection.updated',
  'activity.created',
  'signals.updated',
  'project_summary.updated',
] as const

export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number]

export function isProjectEventType(value: string): value is ProjectEventType {
  return (PROJECT_EVENT_TYPES as readonly string[]).includes(value)
}

/** Activity rail keys — project feed + the workspace ('workspace' fallback) feed. */
function activityKeys(slug: string): QueryKey[] {
  return [['activity', slug], ['activity', 'workspace']]
}

/**
 * Query-key prefixes to invalidate for a given event type in a given project.
 * Exhaustive over {@link ProjectEventType}.
 */
export function invalidationKeysFor(type: ProjectEventType, slug: string): QueryKey[] {
  switch (type) {
    case 'scan_job.updated':
      return [
        ['scans', slug],
        ['scanJobs', slug],
        ['events', slug],
        ['eventTypes', slug],
        ['eventsMetrics', slug],
        ['overview'],
        ...activityKeys(slug),
      ]
    case 'metric_collection.updated':
      return [
        ['scans', slug],
        ['scanJobs', slug],
        ['metrics-catalog', slug],
        ['monitoringMetrics', slug],
        ['metricDefinition', slug],
        ['eventMetricBreakdowns', slug],
        ['eventHistory', slug],
        ['event', slug],
        ['eventsMetrics', slug],
        ['eventWindowMetrics', slug],
        ['appVersionAdoption', slug],
        ['distributionDrifts', slug],
        ['seasonality', slug],
        ['topMovers', slug],
        ['releaseRegressions', slug],
        ['monitors-summary', slug],
        ['monitor', slug],
        ['monitor-history', slug],
        ['reconciliation'],
        ['anomalies', 'signals', slug],
        ['activeSignals', slug],
        ['topbarNotifications', slug],
        ['overview'],
        ...activityKeys(slug),
      ]
    case 'signals.updated':
      return [
        ['anomalies', 'signals', slug],
        ['activeSignals', slug],
        ['monitors-summary', slug],
        ['monitor', slug],
        ['monitor-history', slug],
        ['metricDefinition', slug],
        ['monitoringMetrics', slug],
        ['topbarNotifications', slug],
        ['overview'],
        ...activityKeys(slug),
      ]
    case 'activity.created':
      return [
        ...activityKeys(slug),
        ['topbarNotifications', slug],
        ['alertDeliveries', slug],
      ]
    case 'project_summary.updated':
      return [['projects'], ['project', slug], ['overview']]
  }
}

/**
 * Invalidate every mapped query key for an event. Idempotent — a duplicated
 * event (e.g. replayed on reconnect) simply re-marks the same keys stale.
 */
export function invalidateForEvent(
  queryClient: QueryClient,
  type: ProjectEventType,
  slug: string,
): void {
  for (const queryKey of invalidationKeysFor(type, slug)) {
    void queryClient.invalidateQueries({ queryKey })
  }
}
