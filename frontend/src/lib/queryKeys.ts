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
  ['variables', slug, branchId] as const

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
