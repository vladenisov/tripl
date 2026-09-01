import type { VariableValueDrift, VariableValueDriftStatus } from '@/api/variableDrifts'
import { formatDateTime } from './datetime'

/**
 * Where a drift sits in review. THREE states, because the backend has three and
 * reading only two is what put the table badge and the review panels at odds
 * (tripl-lh61): `_active_drift_predicates` counts `open` AND `snoozed` rows and
 * then drops the ones whose `snoozed_until` is still in the future, so snoozing
 * a variable's last drift feeds a ZERO into `open_drift_count` and the list says
 * nothing needs attention — while the panels, which knew only "resolved vs not",
 * kept that same row in the warning-toned active list with the full Accept /
 * Snooze / False positive row and no way to collapse it.
 *
 * `snoozed` is deliberately NOT folded into `resolved`. A resolution is a
 * decision and comes back only through Reopen; a snooze is a promise to look
 * again, and it lapses on its own. All the two share is that neither is asking
 * for attention right now, which is exactly what the badge counts.
 */
export type DriftReviewState = 'active' | 'snoozed' | 'resolved'

/**
 * Statuses that close review. Such a row comes back only through Reopen — or,
 * for `accepted`, when a scan observes a value OUTSIDE the accepted set (the
 * backend reopens the row itself). Both review panels therefore have to keep
 * resolved rows reachable.
 */
const RESOLVED_DRIFT_STATUSES: ReadonlySet<VariableValueDriftStatus> = new Set([
  'accepted',
  'false_positive',
])

/**
 * Mirrors `_active_drift_predicates` in `variable_value_drift_service.py`, which
 * is the query behind the table's drift badge — the two must give the same
 * answer or the badge and the panels contradict each other again.
 *
 * Note what the backend does NOT say: a snooze whose time has already PASSED is
 * active again, and so is a `snoozed` row carrying no `snoozed_until` at all.
 * Both land back in the open list here exactly as they do in the count.
 *
 * `now` is read at render rather than ticked on a timer. A snooze expiring while
 * the page sits open sorts itself out on the next refetch, and re-rendering
 * every second to catch the moment would cost more than the staleness it saves.
 */
export function driftReviewState(
  drift: Pick<VariableValueDrift, 'status' | 'snoozed_until'>,
  now: number = Date.now(),
): DriftReviewState {
  if (RESOLVED_DRIFT_STATUSES.has(drift.status)) return 'resolved'
  if (drift.status !== 'snoozed') return 'active'
  const until = drift.snoozed_until === null ? Number.NaN : Date.parse(drift.snoozed_until)
  // An unparseable timestamp reads as "no snooze in force", the same way the
  // backend reads a NULL: showing a drift that is not asking for attention is a
  // smaller error than hiding one that is.
  return Number.isNaN(until) || until <= now ? 'active' : 'snoozed'
}

/** The vocabulary the status pill uses. Reached through `driftStatusNote`, which
 * is the only reading that also accounts for a snooze that has lapsed. */
const DRIFT_STATUS_LABEL: Record<VariableValueDriftStatus, string> = {
  open: 'open',
  snoozed: 'snoozed',
  accepted: 'accepted',
  false_positive: 'false positive',
}

/**
 * Text for the row's status pill. A snooze is the one state whose useful content
 * is a TIME: "snoozed" on its own never said when the row comes back, and
 * `snoozed_until` was fetched by `api/variableDrifts.ts` and rendered NOWHERE
 * (tripl-lh61). Deferring review is only defensible if the deferral is legible.
 */
export function driftStatusNote(
  drift: Pick<VariableValueDrift, 'status' | 'snoozed_until'>,
  now: number = Date.now(),
): string {
  if (driftReviewState(drift, now) === 'snoozed' && drift.snoozed_until) {
    const until = formatDateTime(drift.snoozed_until)
    if (until) return `snoozed until ${until}`
  }
  return DRIFT_STATUS_LABEL[drift.status]
}

/**
 * Names the collapsed group behind the "Show N …" toggle. The group holds two
 * unlike things and the button must not claim otherwise — calling a snoozed row
 * "resolved" is the very conflation the badge disagreed with.
 */
export function collapsedDriftLabel(counts: { snoozed: number; resolved: number }): string {
  if (counts.snoozed === 0) return 'resolved'
  if (counts.resolved === 0) return 'snoozed'
  return 'snoozed or resolved'
}

/**
 * The one action that returns a collapsed row to the open list. Both readings
 * post the same backend `reopen`, which clears `snoozed_until` as well as the
 * resolution — so the word differs only because what the reader is undoing
 * does.
 */
export const DRIFT_REVIVE_LABEL: Record<Exclude<DriftReviewState, 'active'>, string> = {
  snoozed: 'Un-snooze',
  resolved: 'Reopen',
}
