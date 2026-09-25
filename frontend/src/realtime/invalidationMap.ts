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
import { refreshEventsLists } from '@/lib/eventsListCache'
import {
  alertDeliveriesAnyKey,
  alertInboxGroupKey,
  alertInboxKey,
  eventsMetricsKey,
  projectEventTypesKey,
  projectKey,
  projectsKey,
} from '@/lib/queryKeys'

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

/**
 * The alert inbox: the incident queue, one incident's deliveries, and the
 * "has this project ever delivered" probe. The inbox does not poll while the
 * stream is live, so without these a new incident never appeared in an open
 * Inbox until a reload (#194 SHELL-29).
 */
function alertInboxKeys(slug: string): QueryKey[] {
  return [alertInboxKey(slug), alertInboxGroupKey(slug), alertDeliveriesAnyKey(slug)]
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
        projectEventTypesKey(slug),
        // The events-tab dynamics chart does not poll while the stream is live.
        eventsMetricsKey(slug),
        ['overview'],
        ...activityKeys(slug),
      ]
    case 'metric_collection.updated':
      return [
        ['scans', slug],
        ['scanJobs', slug],
        ['metrics-catalog', slug],
        eventsMetricsKey(slug),
        ['monitoringMetrics', slug],
        ['metricDefinition', slug],
        ['eventMetricBreakdowns', slug],
        ['eventHistory', slug],
        ['event', slug],
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
        // Covers the Events tabs/rows signals AND the expanded list shared by
        // the bell, Overview and the Anomalies page (tripl-jfm3.119). The old
        // per-surface prefixes ('anomalies'/'overview'/'topbarNotifications'
        // + signals) are gone — one key now, so a new surface cannot forget to
        // register itself here.
        ['activeSignals', slug],
        ['topbarNotifications', slug],
        ['overview'],
        ...activityKeys(slug),
      ]
    case 'signals.updated':
      return [
        ['activeSignals', slug],
        ['monitors-summary', slug],
        ['monitor', slug],
        ['monitor-history', slug],
        ['metricDefinition', slug],
        ['monitoringMetrics', slug],
        ['topbarNotifications', slug],
        ['overview'],
        ...activityKeys(slug),
        ...alertInboxKeys(slug),
      ]
    case 'activity.created':
      return [
        ...activityKeys(slug),
        ['topbarNotifications', slug],
        ['alertDeliveries', slug],
        ...alertInboxKeys(slug),
      ]
    case 'project_summary.updated':
      return [projectsKey(), projectKey(slug), ['overview']]
  }
}

/**
 * Invalidate every mapped query key for an event. Idempotent — a duplicated
 * event (e.g. replayed on reconnect) simply re-marks the same keys stale. The
 * events lists refresh the way a bulk edit refreshes them
 * (`refreshEventsLists`), so a scan landing does not re-request every page
 * the catalog table has scrolled through when it need not.
 */
export function invalidateForEvent(
  queryClient: QueryClient,
  type: ProjectEventType,
  slug: string,
): void {
  for (const queryKey of invalidationKeysFor(type, slug)) {
    if (queryKey[0] === 'events') void refreshEventsLists(queryClient, queryKey)
    else void queryClient.invalidateQueries({ queryKey })
  }
}
