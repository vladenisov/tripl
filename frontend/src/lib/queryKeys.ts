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
