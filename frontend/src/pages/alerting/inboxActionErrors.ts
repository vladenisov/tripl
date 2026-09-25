import type { AlertInboxGroup } from '@/types'

/**
 * A card's failed single action, together with the state of the card it failed
 * against.
 *
 * The error on its own outlived its meaning: a failed Acknowledge on A kept
 * "Could not …" on A after a colleague resolved A, or after the reader resolved
 * it from the bulk bar, for as long as the page stayed mounted — the only path
 * that cleared it was the next single action on that same card. Keeping the
 * snapshot lets the card show the error only while the incident still looks
 * the way it did when the request failed.
 */
export interface InboxActionFailure {
  error: unknown
  /** `inboxGroupStateKey` of the group at the moment the request failed. */
  stateKey: string
}

/**
 * What a triage decision can change on a card. No `updated_at` exists on the
 * group, so the fields an action writes stand in for it.
 */
export function inboxGroupStateKey(
  group: Pick<AlertInboxGroup, 'status' | 'muted_until' | 'note' | 'false_positive_count'>,
): string {
  return JSON.stringify([group.status, group.muted_until, group.note, group.false_positive_count])
}

export function recordInboxActionFailure(group: AlertInboxGroup, error: unknown): InboxActionFailure {
  return { error, stateKey: inboxGroupStateKey(group) }
}

/** The failure to show on `group`, or null once the live group has moved on. */
export function liveInboxActionError(
  failures: ReadonlyMap<string, InboxActionFailure>,
  group: AlertInboxGroup,
): InboxActionFailure | null {
  const failure = failures.get(group.correlation_group_id)
  if (!failure) return null
  return failure.stateKey === inboxGroupStateKey(group) ? failure : null
}
