import { describe, expect, it } from 'vitest'
import type { VariableValueDriftStatus } from '@/api/variableDrifts'
import { formatDateTime } from './datetime'
import { collapsedDriftLabel, driftReviewState, driftStatusNote } from './variableDrift'

const NOW = Date.parse('2026-09-01T12:00:00Z')
const IN_A_WEEK = '2026-09-08T12:00:00Z'
const LAST_WEEK = '2026-08-25T12:00:00Z'

const drift = (status: VariableValueDriftStatus, snoozedUntil: string | null = null) => ({
  status,
  snoozed_until: snoozedUntil,
})

describe('driftReviewState', () => {
  it('reads an open drift as active', () => {
    expect(driftReviewState(drift('open'), NOW)).toBe('active')
  })

  it('reads a snooze that has not run out as neither active nor resolved', () => {
    // The third state the panels had no room for: the backend counts this row
    // as NOT open — so the table badge says zero — while a two-state reading
    // left it in the warning-toned active list (tripl-lh61).
    expect(driftReviewState(drift('snoozed', IN_A_WEEK), NOW)).toBe('snoozed')
  })

  it('puts a LAPSED snooze back on the open list, as the backend count does', () => {
    // `_active_drift_predicates` excludes only FUTURE-snoozed rows. Claiming a
    // spent snooze still defers review would put this page back out of step
    // with the badge, just in the other direction.
    expect(driftReviewState(drift('snoozed', LAST_WEEK), NOW)).toBe('active')
  })

  it('treats the deadline itself as spent, matching `snoozed_until <= now`', () => {
    expect(driftReviewState(drift('snoozed', '2026-09-01T12:00:00Z'), NOW)).toBe('active')
  })

  it('treats a snooze carrying no deadline as active, the way a NULL is counted', () => {
    expect(driftReviewState(drift('snoozed'), NOW)).toBe('active')
  })

  it('treats an unparseable deadline as active rather than hiding the row', () => {
    expect(driftReviewState(drift('snoozed', 'not a timestamp'), NOW)).toBe('active')
  })

  it('reads both resolutions as resolved', () => {
    expect(driftReviewState(drift('accepted'), NOW)).toBe('resolved')
    expect(driftReviewState(drift('false_positive'), NOW)).toBe('resolved')
  })
})

describe('driftStatusNote', () => {
  it('says when a snoozed drift comes back', () => {
    // `snoozed_until` was fetched and rendered nowhere, so neither surface said
    // when the deferral ends (tripl-lh61).
    expect(driftStatusNote(drift('snoozed', IN_A_WEEK), NOW)).toBe(
      `snoozed until ${formatDateTime(IN_A_WEEK)}`,
    )
  })

  it('falls back to the bare status when no snooze is in force', () => {
    expect(driftStatusNote(drift('snoozed', LAST_WEEK), NOW)).toBe('snoozed')
  })

  it('names a resolution plainly', () => {
    expect(driftStatusNote(drift('false_positive'), NOW)).toBe('false positive')
    expect(driftStatusNote(drift('accepted'), NOW)).toBe('accepted')
  })
})

describe('collapsedDriftLabel', () => {
  it('names only what the group actually holds', () => {
    expect(collapsedDriftLabel({ snoozed: 0, resolved: 2 })).toBe('resolved')
    expect(collapsedDriftLabel({ snoozed: 1, resolved: 0 })).toBe('snoozed')
  })

  it('does not call a snoozed row resolved when the group mixes the two', () => {
    expect(collapsedDriftLabel({ snoozed: 1, resolved: 1 })).toBe('snoozed or resolved')
  })
})
