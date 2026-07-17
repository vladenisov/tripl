import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDate, formatDateTime, formatIsoDate, formatRelativeTime, formatTimestamp } from './datetime'

// The formatters delegate to Intl/toLocale* with the host's default locale, so
// we assert on the structured parts (year/month/day, presence of time) that are
// stable across environments rather than an exact localized string.
//
// These formatters render in the viewer's LOCAL zone on purpose — a row's
// "created" date should read as the user's calendar day, unlike a metric bucket
// (see lib/metrics.ts), which is a UTC instant fixed by the warehouse. The
// calendar day of a fixed UTC instant is therefore host-dependent: 10:00Z is
// already the next day in UTC+14. Pin the zone so the expectations below are
// deterministic instead of quietly assuming a UTC host (tripl-64n8.2).
beforeEach(() => {
  vi.stubEnv('TZ', 'UTC')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('formatDate', () => {
  it('renders the calendar date of a UTC instant', () => {
    const out = formatDate('2026-06-21T12:00:00Z')
    expect(out).toContain('2026')
    expect(out).toContain('21')
  })

  it('handles a month rollover at a UTC midnight boundary', () => {
    // 2026-01-31T23:30:00Z is still Jan 31 in UTC.
    const jan = formatDate('2026-01-31T12:00:00Z')
    expect(jan).toContain('2026')
    expect(jan).toContain('31')
  })

  it('handles a year rollover (Dec 31 -> Jan 1)', () => {
    const dec = formatDate('2025-12-31T12:00:00Z')
    const jan = formatDate('2026-01-01T12:00:00Z')
    expect(dec).toContain('2025')
    expect(dec).toContain('31')
    expect(jan).toContain('2026')
    expect(jan).toContain('1')
  })

  it('accepts a date-only ISO string', () => {
    const out = formatDate('2026-06-21')
    expect(out).toContain('2026')
  })
})

describe('formatIsoDate', () => {
  it('renders an unambiguous YYYY-MM-DD date (never US mm/dd/yyyy)', () => {
    // Deterministic because the suite pins TZ=UTC above; the formatter itself
    // still renders the viewer's local calendar day by design.
    const out = formatIsoDate('2026-07-04T10:00:00Z')
    expect(out).toBe('2026-07-04')
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('zero-pads single-digit months and days', () => {
    const out = formatIsoDate('2026-01-05T10:00:00Z')
    expect(out).toBe('2026-01-05')
  })

  it('accepts a date-only ISO string', () => {
    expect(formatIsoDate('2026-07-04')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns an empty string for an unparseable input', () => {
    expect(formatIsoDate('not-a-date')).toBe('')
  })

  it('returns an empty string for an empty input', () => {
    expect(formatIsoDate('')).toBe('')
  })
})

describe('formatDateTime', () => {
  it('includes both the date and a time component', () => {
    const out = formatDateTime('2026-06-21T08:05:00Z')
    expect(out).toContain('2026')
    expect(out).toContain('21')
    // Minutes are zero-padded ('05'); a bare date string would not contain ':'.
    expect(out).toMatch(/\d:\d{2}|\d{2}:\d{2}/)
  })
})

describe('formatTimestamp', () => {
  it('renders an explicit date+time (never the bare US toLocaleString default)', () => {
    const out = formatTimestamp('2026-06-21T08:05:00Z')
    expect(out).toContain('2026')
    expect(out).toContain('21')
    // A ':' proves the time component is present.
    expect(out).toMatch(/\d:\d{2}|\d{2}:\d{2}/)
    // The bare `toLocaleString()` default renders a numeric `m/d/yyyy` date;
    // our explicit options must not, so that string form should be absent.
    // (Asserted locale-agnostically — no reliance on a localized month name.)
    expect(out).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/)
  })

  it('omits seconds by default', () => {
    const out = formatTimestamp('2026-06-21T08:05:07Z')
    expect(out).not.toMatch(/:\d{2}:\d{2}/)
  })

  it('includes seconds when { seconds: true } is passed', () => {
    const out = formatTimestamp('2026-06-21T08:05:07Z', { seconds: true })
    expect(out).toMatch(/:\d{2}:\d{2}/)
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-06-21T12:00:00Z')

  it('returns "never" for null', () => {
    expect(formatRelativeTime(null, now)).toBe('never')
  })

  it('returns "never" for undefined', () => {
    expect(formatRelativeTime(undefined, now)).toBe('never')
  })

  it('returns "never" for an unparseable string', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('never')
  })

  it('returns "just now" under a minute', () => {
    expect(formatRelativeTime('2026-06-21T11:59:30Z', now)).toBe('just now')
  })

  it('clamps future timestamps to "just now" (non-negative diff)', () => {
    expect(formatRelativeTime('2026-06-21T12:05:00Z', now)).toBe('just now')
  })

  it('formats minutes at the 1-minute boundary', () => {
    expect(formatRelativeTime('2026-06-21T11:59:00Z', now)).toBe('1m ago')
  })

  it('rounds to the nearest second before bucketing', () => {
    // 59.4s rounds to 59 -> still "just now".
    expect(formatRelativeTime('2026-06-21T11:59:00.600Z', now)).toBe('just now')
  })

  it('formats hours at the 1-hour boundary', () => {
    expect(formatRelativeTime('2026-06-21T11:00:00Z', now)).toBe('1h ago')
  })

  it('still formats minutes just under an hour', () => {
    expect(formatRelativeTime('2026-06-21T11:00:30Z', now)).toBe('59m ago')
  })

  it('formats days at the 24-hour boundary', () => {
    expect(formatRelativeTime('2026-06-20T12:00:00Z', now)).toBe('1d ago')
  })

  it('still formats hours just under a day', () => {
    expect(formatRelativeTime('2026-06-20T12:30:00Z', now)).toBe('23h ago')
  })

  it('switches to months at 30 days', () => {
    expect(formatRelativeTime('2026-05-22T12:00:00Z', now)).toBe('1mo ago')
  })

  it('still formats days just under 30', () => {
    expect(formatRelativeTime('2026-05-23T12:00:00Z', now)).toBe('29d ago')
  })

  it('switches to years at 365 days', () => {
    expect(formatRelativeTime('2025-06-21T12:00:00Z', now)).toBe('1y ago')
  })

  it('uses Date.now() by default when no reference time is given', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('just now')
  })
})
