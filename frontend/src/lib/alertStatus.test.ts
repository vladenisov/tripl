import { describe, expect, it } from 'vitest'

import type { AlertInboxActionResponse, AlertInboxGroup } from '@/types'

import {
  ALERT_INBOX_STATUS,
  alertInboxStatusLabel,
  inboxActionSuccessMessage,
  incidentMagnitudeLabel,
  incidentReasonLabel,
  incidentWorstDeltaLabel,
  isHandledInboxStatus,
  muteConfirmMessage,
  priorDecisionLabel,
} from './alertStatus'

function makeGroup(overrides: Partial<AlertInboxGroup> = {}): AlertInboxGroup {
  return {
    correlation_group_id: 'grp-1',
    status: 'open',
    muted: false,
    muted_until: null,
    note: null,
    false_positive_count: 0,
    item_count: 1,
    delivery_count: 1,
    latest_bucket: '2026-08-11T10:00:00Z',
    first_delivery_at: '2026-08-11T09:00:00Z',
    latest_delivery_at: '2026-08-11T10:05:00Z',
    direction: 'drop',
    actual_count: 412,
    expected_count: 1010,
    percent_delta: -59.2,
    max_abs_percent_delta: null,
    scope_type: 'event',
    scope_types: ['event'],
    scope_ref: 'scope-a',
    event_id: null,
    scope_names: ['onboarding/reviews_carousel'],
    destination_names: ['TG'],
    rules: [{ id: 'rule-1', name: 'Volume rule' }],
    rule_names: ['Volume rule'],
    scan_names: ['Snowplow Pageviews (iOS)'],
    acted_at: null,
    acted_by: null,
    acted_by_name: null,
    ...overrides,
  }
}

describe('alert inbox status lexicon (tripl-oxkt.16)', () => {
  it('gives every status a human label, never the raw enum member', () => {
    // The badge printed `{group.status}`, so one of them literally read
    // "false_positive".
    expect(alertInboxStatusLabel('false_positive')).toBe('False positive')
    for (const lexeme of Object.values(ALERT_INBOX_STATUS)) {
      expect(lexeme.label).not.toContain('_')
    }
  })

  it('keeps open neutral and gives every handled state its own tone', () => {
    // 52 of 57 production groups are open. Tinting 52 of 57 rows destroys the
    // scanning benefit the colour exists for, so colour marks the minority
    // somebody has already decided about.
    expect(ALERT_INBOX_STATUS.open.tone).toBe('neutral')
    const handledTones = (['acknowledged', 'muted', 'resolved', 'false_positive'] as const).map(
      status => ALERT_INBOX_STATUS[status].tone,
    )
    expect(new Set(handledTones).size).toBe(handledTones.length)
    expect(handledTones).not.toContain('neutral')
  })

  it('counts everything but open as handled', () => {
    expect(isHandledInboxStatus('open')).toBe(false)
    expect(isHandledInboxStatus('acknowledged')).toBe(true)
    expect(isHandledInboxStatus('muted')).toBe(true)
  })
})

describe('what fired, on the card (tripl-oxkt.4)', () => {
  it('names direction and scope kind together', () => {
    expect(incidentReasonLabel('drop', ['event'])).toBe('drop · volume')
    expect(incidentReasonLabel('drop', ['release_regression'])).toBe('drop · release regression')
  })

  it('names every kind in a mixed group, not just the newest item\'s', () => {
    // Suppression is an exact match on the whole key; describing a mixed
    // incident by one member is how the mute's blast radius gets mis-read.
    expect(incidentReasonLabel('spike', ['event', 'release_regression'])).toBe(
      'spike · volume + release regression',
    )
  })

  it('writes the magnitude against its baseline', () => {
    expect(incidentMagnitudeLabel(makeGroup())).toContain('expected · -59.2%')
  })

  it('says a zero baseline in words, never as 0%', () => {
    // `percent_delta` is NULL exactly when there is nothing to divide by. The
    // stored 0.0 it replaced reported the largest possible relative move as the
    // smallest one (tripl-l429.24).
    const label = incidentMagnitudeLabel(
      makeGroup({ actual_count: 412, expected_count: 0, percent_delta: null }),
    )
    expect(label).toBe('412 actual, none expected · no baseline')
    expect(label).not.toContain('0%')
  })

  it('reports the worst magnitude only when the group holds more than one item', () => {
    expect(incidentWorstDeltaLabel({ item_count: 1, max_abs_percent_delta: 92.4 })).toBeNull()
    expect(incidentWorstDeltaLabel({ item_count: 6, max_abs_percent_delta: 92.4 })).toBe(
      'worst 92.4% in this group',
    )
    expect(incidentWorstDeltaLabel({ item_count: 6, max_abs_percent_delta: null })).toBeNull()
  })

  it('surfaces a decision that the auto-reopen has undone', () => {
    // `_reopen_closed_incidents` resets a closed incident to open once the
    // scope goes quiet and never touches `acted_at` — so an incident somebody
    // closed last week was pixel-identical to one nobody had ever seen.
    const line = priorDecisionLabel(
      makeGroup({ acted_at: '2026-07-30T12:00:00Z', acted_by_name: 'V. Denisov' }),
    )
    expect(line).toMatch(/^Closed .* by V\. Denisov · firing again, latest /)
  })

  it('says nothing about a decision on a card that is still closed', () => {
    // A resolved card already says "Resolved"; the line exists for the case
    // where the status no longer shows that anything happened.
    expect(
      priorDecisionLabel(makeGroup({ status: 'resolved', acted_at: '2026-07-30T12:00:00Z' })),
    ).toBeNull()
    expect(priorDecisionLabel(makeGroup({ acted_at: null }))).toBeNull()
  })
})

describe('the confirmation names the whole suppression key (tripl-oxkt.7)', () => {
  it('spells scope, kind, direction, scan and rule, then what is not covered', () => {
    const message = muteConfirmMessage(makeGroup(), '2026-08-19T10:00:00Z')

    expect(message).toContain('drop · volume')
    expect(message).toContain('onboarding/reviews_carousel')
    expect(message).toContain('Snowplow Pageviews (iOS)')
    expect(message).toContain('Volume rule')
    // The user's model is "not this thing again"; the system's is a five-part
    // exact match. Every gap between them is an incident somebody believes they
    // silenced and did not.
    expect(message).toContain('Nothing else is silenced')
  })
})

describe('an action says what it actually did (tripl-oxkt.6)', () => {
  function response(overrides: Partial<AlertInboxActionResponse> = {}): AlertInboxActionResponse {
    return { group: makeGroup(), overrides_written: null, ...overrides }
  }

  it('counts the scopes a false positive really tightened', () => {
    expect(
      inboxActionSuccessMessage('false_positive', 'open', response({ overrides_written: 3 })),
    ).toContain('tightened 3 scopes')
    expect(
      inboxActionSuccessMessage('false_positive', 'open', response({ overrides_written: 1 })),
    ).toContain('tightened 1 scope')
  })

  it('admits when it tightened nothing at all', () => {
    // The ratchet skips any scope kind outside RATCHETABLE_SCOPE_TYPES, and
    // release_regression is not in it — 10 of 57 production groups. The tooltip
    // promised a permanent detection change on every one of them.
    const message = inboxActionSuccessMessage(
      'false_positive',
      'open',
      response({ overrides_written: 0 }),
    )
    expect(message).toContain('no scopes tightened')
    expect(message).not.toContain('tightened 0')
  })

  it('calls lifting a mute "unmuted", and reopening anything else "reopened"', () => {
    expect(inboxActionSuccessMessage('reopen', 'muted', response())).toContain('Unmuted')
    expect(inboxActionSuccessMessage('reopen', 'resolved', response())).toContain('Reopened')
  })

  it('names the instant a mute lifts', () => {
    const message = inboxActionSuccessMessage(
      'mute',
      'open',
      response({ group: makeGroup({ status: 'muted', muted: true, muted_until: '2026-08-19T10:00:00Z' }) }),
    )
    expect(message).toMatch(/^Muted until /)
  })
})
