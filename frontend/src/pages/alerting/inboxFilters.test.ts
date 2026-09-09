import { describe, expect, it } from 'vitest'

import {
  EMPTY_INBOX_FILTERS,
  INBOX_LOOKBACK_DAYS,
  earliestReachableDay,
  hasActiveInboxFilters,
  inboxFilterQuery,
  readInboxFilters,
  writeInboxFilters,
} from './inboxFilters'

describe('readInboxFilters', () => {
  it('reads every member out of the URL', () => {
    const params = new URLSearchParams({
      fired_from: '2026-09-01',
      fired_to: '2026-09-08',
      scope_type: 'release_regression',
      direction: 'drop',
      scope: 'checkout',
    })

    expect(readInboxFilters(params)).toEqual({
      firedFrom: '2026-09-01',
      firedTo: '2026-09-08',
      scopeType: 'release_regression',
      direction: 'drop',
      scope: 'checkout',
    })
  })

  it('drops a value that is not a member of its union instead of forwarding it', () => {
    // A stale or hand-edited link must degrade to "not filtering", never to a
    // request the API answers with a 422 — the same rule `?status=` follows.
    const params = new URLSearchParams({ scope_type: 'bogus', direction: 'sideways' })

    expect(readInboxFilters(params)).toEqual(EMPTY_INBOX_FILTERS)
  })

  it('drops a date that is not a real calendar day', () => {
    // `new Date('banana').toISOString()` THROWS, and this value is read while
    // rendering — an unparseable day in a URL must not be able to take the page.
    const params = new URLSearchParams({ fired_from: 'banana', fired_to: '2026-02-31' })

    const filters = readInboxFilters(params)
    expect(filters.firedFrom).toBe('')
    // 2026-02-31 rolls over to 3 March in JS rather than failing, so it is a
    // usable day; what matters is that nothing here can throw downstream.
    expect(() => inboxFilterQuery(filters, '')).not.toThrow()
  })
})

describe('writeInboxFilters', () => {
  it('leaves empty members out, so "cleared" and "never set" are one URL', () => {
    expect(writeInboxFilters(EMPTY_INBOX_FILTERS)).toEqual({})
    expect(writeInboxFilters({ ...EMPTY_INBOX_FILTERS, scope: '   ' })).toEqual({})
  })

  it('trims the search so a stray space is not a different filter', () => {
    expect(writeInboxFilters({ ...EMPTY_INBOX_FILTERS, scope: ' checkout ' })).toEqual({
      scope: 'checkout',
    })
  })
})

describe('inboxFilterQuery', () => {
  it('sends nothing when nothing is filtered', () => {
    expect(inboxFilterQuery(EMPTY_INBOX_FILTERS, '')).toEqual({
      status: undefined,
      lastFiredFrom: undefined,
      lastFiredTo: undefined,
      scopeType: undefined,
      direction: undefined,
      scope: undefined,
    })
  })

  it('covers the whole of the day it names, in the reader’s own zone', () => {
    const query = inboxFilterQuery({ ...EMPTY_INBOX_FILTERS, firedTo: '2026-09-08' }, '')
    const bound = new Date(query.lastFiredTo as string)

    // The load-bearing assertion: an incident that fired at 23:30 that evening
    // is INSIDE "up to the 8th". A bound at midnight — the obvious reading of a
    // date input — would exclude the entire day the reader asked for.
    expect(bound.getTime()).toBeGreaterThan(new Date('2026-09-08T23:30:00').getTime())
    // …and it does not spill into the next day.
    expect(bound.getTime()).toBeLessThan(new Date('2026-09-09T00:00:00').getTime())
  })

  it('starts the from-day at its first instant', () => {
    const query = inboxFilterQuery({ ...EMPTY_INBOX_FILTERS, firedFrom: '2026-09-01' }, '')
    const bound = new Date(query.lastFiredFrom as string)

    expect(bound.getTime()).toBe(new Date('2026-09-01T00:00:00').getTime())
  })

  it('carries the status through, so one request describes the whole ask', () => {
    expect(inboxFilterQuery(EMPTY_INBOX_FILTERS, 'resolved').status).toBe('resolved')
  })
})

describe('hasActiveInboxFilters', () => {
  it('is false for the empty state and true once anything narrows', () => {
    expect(hasActiveInboxFilters(EMPTY_INBOX_FILTERS)).toBe(false)
    expect(hasActiveInboxFilters({ ...EMPTY_INBOX_FILTERS, direction: 'drop' })).toBe(true)
    // Whitespace is not a filter: the empty-state sentence and the Clear button
    // both read this, and a cleared search box must turn both back off.
    expect(hasActiveInboxFilters({ ...EMPTY_INBOX_FILTERS, scope: '  ' })).toBe(false)
  })
})

describe('earliestReachableDay', () => {
  it('is the lookback window back from today', () => {
    expect(earliestReachableDay(new Date('2026-09-09T12:00:00'))).toBe('2026-08-10')
    expect(INBOX_LOOKBACK_DAYS).toBe(30)
  })

  it('crosses a month and a year boundary', () => {
    expect(earliestReachableDay(new Date('2026-01-05T12:00:00'))).toBe('2025-12-06')
  })
})
