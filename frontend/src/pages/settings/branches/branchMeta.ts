/**
 * Labels, tones and routes the Branches tab's components share. Kept out of the
 * component files so each of those stays component-only (react-refresh).
 */

import type { ChipTone } from '@/components/primitives/chip'
import { displayUser } from '@/hooks/useUsersById'
import { formatRelativeTime } from '@/lib/datetime'
import type {
  PlanBranchStatus,
  PlanBranchSummary,
  PlanBranchTransitionAction,
  PlanDiffEntityType,
  PlanDiffEntry,
  PlanDiffKind,
} from '@/types'

export const STATUS_LABEL: Record<PlanBranchStatus, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed',
}

export const STATUS_TONE: Record<PlanBranchStatus, ChipTone> = {
  draft: 'neutral',
  ready_for_review: 'info',
  changes_requested: 'danger',
  approved: 'success',
  merged: 'neutral',
  closed: 'neutral',
}

export const ALLOWED_TRANSITIONS: Record<PlanBranchStatus, PlanBranchTransitionAction[]> = {
  draft: ['submit', 'close'],
  ready_for_review: ['approve', 'request_changes', 'close'],
  changes_requested: ['submit', 'close'],
  // approve stays available so extra reviewers can stack approvals toward the
  // project's min_approvals quota.
  approved: ['approve', 'request_changes', 'reopen', 'close'],
  closed: ['reopen'],
  merged: [],
}

export const ACTION_LABEL: Record<PlanBranchTransitionAction, string> = {
  submit: 'Submit for review',
  request_changes: 'Request changes',
  approve: 'Approve',
  reopen: 'Reopen',
  close: 'Close',
}

/** Verdicts read the diff, so they wait for it; see FeatureBranchDetail. */
export const DIFF_VERDICTS: ReadonlySet<PlanBranchTransitionAction> = new Set([
  'approve',
  'request_changes',
])

// Maps a real diff kind to the mockup's tone-coded gutter symbol / chip label.
export const KIND_META: Record<PlanDiffKind, { tone: ChipTone; sym: string; label: string }> = {
  added: { tone: 'success', sym: '+', label: 'Added' },
  changed: { tone: 'warning', sym: '~', label: 'Modified' },
  removed: { tone: 'danger', sym: '−', label: 'Removed' },
}

// A rename has no diff kind of its own — it arrives as a removal plus an
// addition — but it is not a deletion, and a red "Removed" row sitting beside an
// unrelated green "Added" one says it is. This is what the paired row wears
// instead (tripl-amnn).
export const RENAMED_META: { tone: ChipTone; sym: string; label: string } = {
  tone: 'warning',
  sym: '→',
  label: 'Renamed',
}

// Human-readable entity labels for the expanded change detail.
export const ENTITY_LABEL: Record<PlanDiffEntityType, string> = {
  event_type: 'event type',
  field_definition: 'field',
  event: 'event',
  variable: 'variable',
  meta_field: 'meta field',
  relation: 'relation',
}

const LANDED_STATUSES = new Set(['merged', 'closed'])

/**
 * Landed work — merged or closed — as opposed to a branch still in flight.
 *
 * The `kind` test is load-bearing rather than defensive: **main is created with
 * status `merged`**. A status-only predicate therefore files the production plan
 * under "Merged" and leaves the active tab with no base branch, which is also
 * why this split stays client-side — `BranchSwitcher` reads the very same
 * `planBranchesKey(slug)` cache entry, so filtering server-side would empty it
 * too.
 */
export function isLandedBranch(branch: PlanBranchSummary): boolean {
  return branch.kind !== 'main' && LANDED_STATUSES.has(branch.status)
}

/** The API serialises `created_by` as a bare user id; resolve it against the
 * project roster (GET /users is open to any authenticated user), preferring
 * the name and falling back to the email — same convention as EventRow. */
export function branchAuthor(branch: PlanBranchSummary, usersById: Map<string, string>): string {
  return displayUser(usersById, branch.created_by)
}

export function branchSubtitle(branch: PlanBranchSummary, usersById: Map<string, string>): string {
  if (branch.kind === 'main') return 'production'
  return `${branchAuthor(branch, usersById)} · ${formatRelativeTime(branch.updated_at)}`
}

/** The human title an event carries beside its scan name, so a reviewer reading
 * `tap_model_card` also sees "Tap on a model card" (tripl-kjhi.3). Branch side
 * first; a removed entry only has a base side. Events only — that is the one
 * entity whose `title` is a field the plan editor shows. */
export function eventTitle(entry: PlanDiffEntry): string | null {
  if (entry.entity_type !== 'event') return null
  for (const state of [entry.after, entry.before]) {
    const value = state?.title
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/** Where a diff row points. Field definitions, meta fields and relations have no
 * detail route yet — those rows stay unlinked. */
export function entityPath(slug: string, entry: PlanDiffEntry): string | null {
  if (!entry.entity_id) return null
  switch (entry.entity_type) {
    case 'event':
      return `/p/${slug}/events/all/${entry.entity_id}`
    case 'event_type':
      return `/p/${slug}/settings/event-types/${entry.entity_id}`
    case 'variable':
      return `/p/${slug}/settings/variables/${entry.entity_id}`
    default:
      return null
  }
}

/** Where a diff row's Edit action points, per entity type.
 *
 * An event has an editor ROUTE, and `/events/:tab/:eventId/edit` is a
 * first-class one, so this skips the list route that would otherwise bounce
 * through EventsPage.
 *
 * A variable has an editor too — the Variables tab's dialog — but no address of
 * its own, so the row asks the tab to open it with `?edit=1` on the same link
 * that already focuses the row (tripl-htfn.2). Without it, fixing a variable
 * from a branch review cost exactly the clicks tripl-h2sx.1 removed for events:
 * expand the row, find the 11px link after Revert, land on a highlighted row
 * that is not open.
 *
 * Event types are deliberately absent. `entityPath` already lands them on
 * EventTypeDetail, which IS their editor, so a second affordance to the same
 * page would not be closing the same gap.
 */
export function entityEditPath(
  slug: string,
  entityType: PlanDiffEntry['entity_type'],
  entityId: string,
): string | null {
  switch (entityType) {
    case 'event':
      return `/p/${slug}/events/all/${entityId}/edit`
    case 'variable':
      return `/p/${slug}/settings/variables/${entityId}?edit=1`
    default:
      return null
  }
}
