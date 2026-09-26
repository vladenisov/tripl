import { describe, expect, it } from 'vitest'

import { formatDateTime } from '@/lib/datetime'
import { chartCaption } from './chartCaption'

const NOW = Date.parse('2026-09-26T12:00:00Z')

describe('chartCaption (L4)', () => {
  it('names the cadence alone when the response carries nothing else', () => {
    expect(chartCaption({ cadence: 'hour', now: NOW })).toBe('Hourly')
  })

  it('adds the newest bucket, the last collection and the next one', () => {
    expect(
      chartCaption({
        cadence: 'hour',
        lastBucket: '2026-09-26T10:00:00Z',
        lastCollectedAt: '2026-09-26T11:05:00Z',
        nextCollectionAt: '2026-09-26T13:00:00Z',
        now: NOW,
      }),
    ).toBe(
      `Hourly · newest bucket 2h ago · collected 55m ago · next ${formatDateTime('2026-09-26T13:00:00Z')}`,
    )
  })

  it('says "due now" for a next run inside the scheduler tick or already past', () => {
    expect(
      chartCaption({ cadence: 'day', nextCollectionAt: '2026-09-26T12:00:00Z', now: NOW }),
    ).toBe('Daily · next collection due now')
    expect(
      chartCaption({ cadence: 'day', nextCollectionAt: '2026-09-26T12:03:00Z', now: NOW }),
    ).toBe('Daily · next collection due now')
  })

  it('drops an unparseable next time instead of printing it', () => {
    expect(chartCaption({ cadence: 'week', nextCollectionAt: 'soon', now: NOW })).toBe('Weekly')
  })
})
