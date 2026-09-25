/**
 * The Branches tab's query keys, and which of them each branch action has to
 * refresh.
 *
 * Every key here used to be a string literal retyped at each reader and each
 * invalidation, which is how a merge came to refresh the branch list but not
 * the conflicts panel, nor any of main's plan caches (PLAN-2, PLAN-4). Only this
 * tab reads these families; `planBranchesKey` stays in lib/queryKeys.ts
 * because the sidebar switcher shares it.
 */

import type { QueryClient } from '@tanstack/react-query'
import {
  eventTypesKey,
  planBranchesKey,
  projectEventTypesKey,
  projectVariablesKey,
  variablesKey,
} from '@/lib/queryKeys'

/** The list WITH ahead/behind counts. A sibling of `planBranchesKey`, not an
 * extension: the counted list builds one plan snapshot per open branch plus
 * one for main, with no cap, and a status change (submit, approve, request
 * changes) moves no count. So it is refreshed only by what changes a plan —
 * see `invalidateBranchCounts` — not by every invalidation of the plain list. */
export const planBranchCountsKey = (slug: string) => ['planBranchCounts', slug] as const

/** After a create, a revert, a merge, a delete or a reopen: the only actions
 * that change a branch's content or bring a branch back into the counted set. */
export function invalidateBranchCounts(qc: QueryClient, slug: string) {
  void qc.invalidateQueries({ queryKey: planBranchCountsKey(slug) })
}

export const planBranchDiffKey = (slug: string, branchId: string | undefined) =>
  ['planBranchDiff', slug, branchId] as const

export const planBranchDetailKey = (slug: string, branchId: string) =>
  ['planBranchDetail', slug, branchId] as const

export const planBranchConflictsKey = (slug: string, branchId: string) =>
  ['planBranchConflicts', slug, branchId] as const

export const planBranchCommentsKey = (slug: string, branchId: string) =>
  ['planBranchComments', slug, branchId] as const

export const planBranchTicketsKey = (slug: string, branchId: string) =>
  ['planBranchImplementationTickets', slug, branchId] as const

export const branchSettingsKey = (slug: string) => ['branchSettings', slug] as const

/** Shared with TrackerConfigDialog, which reads the same `GET /tracker-config`. */
export const trackerConfigKey = (slug: string) => ['trackerConfig', slug] as const

/**
 * After a tracked merge the worker writes the ticket a moment after the merge
 * response (`create_implementation_ticket.delay`), so the panel polls while the
 * list is still empty — for a bounded window, because a tracker that failed
 * must not be polled forever (PLAN-10).
 */
export const TICKET_POLL_MS = 2000
export const TICKET_POLL_WINDOW_MS = 30_000

/** Everything the review screen shows about one branch. */
export function invalidateBranchReview(qc: QueryClient, slug: string, branchId: string) {
  void qc.invalidateQueries({ queryKey: planBranchesKey(slug) })
  void qc.invalidateQueries({ queryKey: planBranchDiffKey(slug, branchId) })
  void qc.invalidateQueries({ queryKey: planBranchDetailKey(slug, branchId) })
  // Main may have gained a conflicting edit since the panel loaded; a merge
  // refused for "field conflicts below" must find them below (PLAN-4).
  void qc.invalidateQueries({ queryKey: planBranchConflictsKey(slug, branchId) })
  void qc.invalidateQueries({ queryKey: planBranchTicketsKey(slug, branchId) })
}

/**
 * Every plan cache main feeds, across all branches: after a merge the events,
 * variables, event types, meta fields, relations and history of main are all
 * different, and a reviewer who clicks through to Events must not see main as
 * it was before the merge for the minute of `staleTime` (PLAN-2).
 */
export function invalidateMainPlan(qc: QueryClient, slug: string) {
  for (const queryKey of [
    projectEventTypesKey(slug),
    projectVariablesKey(slug),
    ['events', slug],
    // The single-event reader and editor, its tags and its history: an editor
    // opened on pre-merge data saves it straight back over the merge.
    ['event', slug],
    ['eventTags', slug],
    ['eventHistory', slug],
    ['metaFields', slug],
    ['relations', slug],
    ['planRevisions', slug],
  ]) {
    void qc.invalidateQueries({ queryKey })
  }
}

/** The branch's own plan caches: a revert rewrites the branch, so its editors
 * must not keep showing the reverted state (PLAN-16). */
export function invalidateBranchPlan(qc: QueryClient, slug: string, branchId: string) {
  for (const queryKey of [
    eventTypesKey(slug, branchId),
    variablesKey(slug, branchId),
    ['events', slug, branchId],
    // EventForm edits from ['event', slug, branchId, eventId]; a stale copy
    // there would PUT the reverted values back (no version check).
    ['event', slug, branchId],
    ['eventTags', slug, branchId],
    ['eventHistory', slug, branchId],
    ['metaFields', slug, branchId],
    ['relations', slug, branchId],
  ]) {
    void qc.invalidateQueries({ queryKey })
  }
}
