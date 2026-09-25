/**
 * Canonical React Query keys for the caches that have drifted.
 *
 * A query key is a string literal, so nothing catches two spellings of the same
 * cache — the reader and the writer simply stop seeing each other and the UI
 * goes quietly stale. That has now happened three times:
 *
 * - `['data-sources']` (metric card, metric form, fact-table form and list) vs
 *   `['dataSources']`, the one DataSourcesPage invalidates and `setQueryData`s
 *   (tripl-jfm3.115) — four surfaces kept showing a source you had just edited;
 * - `['plan-branches', slug]` in the sidebar switcher vs `['planBranches', slug]`
 *   invalidated by BranchesTab (tripl-jfm3.116) — creating or merging a branch
 *   left the switcher stale;
 * - three spellings of the expanded signals list (tripl-jfm3.119).
 *
 * Importing the key instead of retyping it makes a fourth impossible: a typo is
 * a compile error rather than a silent second cache. Add a family here when it
 * is read in more than one file.
 */

import { queryOptions } from '@tanstack/react-query'
import { projectsApi } from '@/api/projects'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'

/** Workspace data sources — `GET /data-sources`, one list for the whole app. */
export const dataSourcesKey = () => ['dataSources'] as const

/** Plan branches for one project — `GET /projects/{slug}/branches`. */
export const planBranchesKey = (slug: string | undefined) => ['planBranches', slug] as const

/**
 * Project variables, ITEMS ONLY — `variablesApi.list`, an array.
 *
 * The fourth drift, and the first that crashed rather than went stale: four
 * queries shared the literal `['variables', slug, branchId]`, but VariablesTab
 * fetched `listPage`, whose value is the `{items, total}` envelope, while the
 * events table, the events page data hook and the event form fetched `list`,
 * whose value is the array. One cache, two shapes — so opening
 * Settings -> Variables and then switching to Events in the sidebar handed the
 * event rows an object, and `for (const variable of variables)` threw
 * "t is not iterable" on production.
 *
 * Same spelling, different value shape: the key-spelling check below would not
 * have caught it, which is exactly why the two shapes now have two keys.
 */
export const variablesKey = (slug: string | undefined, branchId?: string | null) =>
  [...projectVariablesKey(slug), branchId] as const

/**
 * EVERY variables cache for a project, across all branches.
 *
 * For a caller that changes variables without knowing which branch is on
 * screen — the owner-only retirement pass in the project danger zone resolves
 * the branch server-side, so that button holds a slug and nothing else. React
 * Query matches invalidations by prefix and this is a strict prefix of
 * {@link variablesKey}, so one call refreshes the settings table whichever
 * branch it is showing. Invalidating `variablesKey(slug)` instead would build
 * `['variables', slug, undefined]`, which matches no branch-scoped cache at all.
 */
export const projectVariablesKey = (slug: string | undefined) => ['variables', slug] as const

/**
 * Project variables, PAGE ENVELOPE — `variablesApi.listPage`, `{items, total}`.
 *
 * Deliberately an extension of {@link variablesKey} rather than a sibling: React
 * Query matches invalidations by prefix, so every existing
 * `invalidateQueries({ queryKey: variablesKey(...) })` still refreshes both
 * caches after a variable is created, edited or deleted.
 */
export const variablesPageKey = (slug: string | undefined, branchId?: string | null) =>
  [...variablesKey(slug, branchId), 'page'] as const

/**
 * EVERY event-type cache for a project, across all branches.
 *
 * The fifth drift, and the same prefix trap as {@link projectVariablesKey}: two
 * readers hold a project but no branch — the Scans tab, which maps type ids to
 * names for its "Review events" deep links, and the alert-rule editor's filter
 * rows — so they fetched `['eventTypes', slug]`. Every mutation invalidated the
 * branch-scoped `['eventTypes', slug, branchId]`, and a three-element filter is
 * never a prefix of a two-element key, so renaming or deleting a type left both
 * of those surfaces pointing at a name that no longer existed.
 *
 * Invalidate THIS one after a write: it is a strict prefix of
 * {@link eventTypesKey}, so it refreshes the branch-scoped caches too.
 */
export const projectEventTypesKey = (slug: string | undefined) => ['eventTypes', slug] as const

/** Event types for one project on one branch — `eventTypesApi.list(slug, branchId)`. */
export const eventTypesKey = (slug: string | undefined, branchId?: string | null) =>
  [...projectEventTypesKey(slug), branchId] as const

/** Every metrics-catalog list cache for a project (filters extend the key). */
export const metricsCatalogKey = (slug: string | undefined) => ['metrics-catalog', slug] as const

/** One catalog metric's definition — or, without `metricId`, all of them. */
export const metricDefinitionKey = (slug: string | undefined, metricId?: string) =>
  metricId === undefined
    ? (['metricDefinition', slug] as const)
    : (['metricDefinition', slug, metricId] as const)

/** The generated batch SQL of every metric in a project. */
export const metricGeneratedSqlKey = (slug: string | undefined) =>
  ['metric-generated-sql', slug] as const

/**
 * The drilldown caches MonitoringDetailPage fills for one entity, by scope
 * (`event`, `event_type`, `project_total`, `metric`). The page extends each with
 * its range and filters; these prefixes are what a save, a collect or the
 * realtime layer invalidates.
 */
export const monitoringSeriesKey = (slug: string | undefined, scope: string, scopeId: string) =>
  ['monitoringMetrics', slug, scope, scopeId] as const
export const monitoringBreakdownsKey = (slug: string | undefined, scope: string, scopeId: string) =>
  ['eventMetricBreakdowns', slug, scope, scopeId] as const
export const appVersionSeriesKey = (slug: string | undefined, scope: string, scopeId: string) =>
  ['appVersionSeries', slug, scope, scopeId] as const
/** Chart annotations shown on one entity's drilldown. */
export const chartAnnotationsKey = (slug: string | undefined, scope: string, scopeId: string) =>
  ['chartAnnotations', slug, scope, scopeId] as const

/**
 * Prefixes of every drilldown cache one catalog metric fills: its series, its
 * breakdowns and its app-version series (MonitoringDetailPage keys them all
 * `[family, slug, 'metric', metricId, …]`). A save that redefines the metric
 * makes the backend delete what those hold, so they must be refetched rather
 * than served stale for the minute of `staleTime` (MET-27).
 */
export const metricDrilldownKeys = (slug: string | undefined, metricId: string) =>
  [
    monitoringSeriesKey(slug, 'metric', metricId),
    monitoringBreakdownsKey(slug, 'metric', metricId),
    appVersionSeriesKey(slug, 'metric', metricId),
  ] as const

/** Every project the viewer can see — `GET /projects`, one list for the app. */
export const projectsKey = () => ['projects'] as const

/**
 * The one definition of the projects-list query. Six components read this
 * cache; each used to redeclare it with slightly different options, so
 * whichever mounted first decided how it behaved. Spread it and override only
 * what a reader genuinely needs (`enabled: false` for a cache-only read).
 *
 * Silent for every reader, because its failure has exactly two owners that
 * render it: Layout's "Backend is unavailable" card for every page inside the
 * app shell (the workspace dashboard included — it shows no card of its own),
 * and the settings takeover's card, which mounts outside Layout. Opting out on
 * one observer was not enough — a query's meta is whichever observer set its
 * options last — so the card used to come with a toast saying the same thing.
 * A reader that adds its own error card for this query reports it twice.
 */
export const projectsQueryOptions = () =>
  queryOptions({
    queryKey: projectsKey(),
    queryFn: ({ signal }) => projectsApi.list(signal),
    meta: SILENT_ERROR_META,
  })

/**
 * Every events-tab dynamics cache for a project — `metricsApi.getEventsMetrics`.
 * TabMetricsCard extends it with branch, filters and range; the realtime layer
 * invalidates this prefix because the card does not poll while the stream is
 * live, so a finished scan or collection would otherwise never reach the chart.
 */
export const eventsMetricsKey = (slug: string | undefined) => ['eventsMetrics', slug] as const

/** One project — `GET /projects/{slug}`. */
export const projectKey = (slug: string | undefined) => ['project', slug] as const

/** The one definition of the single-project query; spread it to add `enabled`. */
export const projectQueryOptions = (slug: string | undefined) =>
  queryOptions({
    queryKey: projectKey(slug),
    queryFn: ({ signal }) => projectsApi.get(slug as string, signal),
  })

/**
 * The alert inbox caches for a project: the grouped inbox list, one group's
 * deliveries, and the "has this project ever delivered" probe. The realtime
 * layer invalidates all three when a delivery lands.
 */
export const alertInboxKey = (slug: string | undefined) => ['alertInbox', slug] as const
export const alertInboxGroupKey = (slug: string | undefined) => ['alertInboxGroup', slug] as const
export const alertDeliveriesAnyKey = (slug: string | undefined) =>
  ['alertDeliveriesAny', slug] as const
