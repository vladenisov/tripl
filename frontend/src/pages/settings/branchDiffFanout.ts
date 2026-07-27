import type { PlanBranchSummary } from '@/types'

/**
 * Fan-out policy for the Branches tab's ahead/behind badges.
 *
 * A branch diff is a server-side plan comparison (measured at 2-3.5 s on a real
 * project) and the list needs one per feature branch, because the branch list
 * endpoint carries no counts. Two guards keep that from growing with the branch
 * count (tripl-jfm3.50): cache the diffs long enough that re-entering the tab
 * costs no requests, and cap how many rows fan out at once.
 *
 * Lives outside BranchesTab.tsx so that file stays component-only
 * (react-refresh) and the policy is unit-testable on its own.
 */
export const DIFF_STALE_MS = 5 * 60 * 1000
export const ROW_DIFF_LIMIT = 8

/**
 * The feature branches whose ahead/behind counts the list will fetch: the
 * selected branch (its diff is already loaded for the detail pane, so it is
 * free) plus the most recently updated others, capped at ROW_DIFF_LIMIT.
 * Rows outside the cap render without a badge instead of costing a request.
 */
export function rowDiffBranches(
  featureBranches: PlanBranchSummary[],
  selectedId: string | null,
): PlanBranchSummary[] {
  if (featureBranches.length <= ROW_DIFF_LIMIT) return featureBranches
  const selected = featureBranches.filter((b) => b.id === selectedId)
  const rest = featureBranches
    .filter((b) => b.id !== selectedId)
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return [...selected, ...rest.slice(0, ROW_DIFF_LIMIT - selected.length)]
}
