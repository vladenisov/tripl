import type { EventCommentStatus } from '@/types'

/**
 * Does this thread still want an answer?
 *
 * A lapsed snooze counts as open again — the same rule the server applies in
 * `unanswered_clause`, and the reason the state is derived on both sides rather
 * than stored: a written-back flag is wrong for as long as it takes a sweeper to
 * run, and the whole point of a snooze is that nobody is watching in between.
 *
 * A thread with no status at all is open. The branch-review thread has no
 * resolution columns, and an older server answers without them; neither is a
 * resolved question.
 */
export function isThreadUnanswered(
  comment: { status?: EventCommentStatus; snoozed_until?: string | null },
  now: Date = new Date(),
): boolean {
  if (!comment.status || comment.status === 'open') return true
  if (comment.status !== 'snoozed') return false
  if (!comment.snoozed_until) return true
  const until = new Date(comment.snoozed_until)
  return Number.isNaN(until.getTime()) || until <= now
}

/** What the thread's header says about itself. Null while it is simply open —
 *  a badge on every unanswered thread would be noise on the common case. */
export function threadStateLabel(
  comment: { status?: EventCommentStatus; snoozed_until?: string | null },
  now: Date = new Date(),
): string | null {
  if (comment.status === 'resolved') return 'resolved'
  if (comment.status === 'snoozed' && !isThreadUnanswered(comment, now)) return 'snoozed'
  return null
}
