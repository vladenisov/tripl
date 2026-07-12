import { afterEach, describe, expect, it, vi } from 'vitest'
import { axisWidthForValues, formatCount, formatTick, formatTooltipLabel } from './chart-format'

/**
 * Axis and tooltip labels name a UTC bucket start, so they must render in UTC.
 * Rendered in the viewer's local zone, a Monday week bucket prints as "Week of
 * Jun 7" (Sunday) west of Greenwich and a day bucket prints under the wrong
 * date — the axis would then disagree with the bucket the server computed
 * (tripl-64n8.2). Node re-reads `process.env.TZ` on every Date operation, so
 * stubbing it swings the host zone under the formatter.
 */
describe('bucket labels render in UTC', () => {
  const ZONES = ['UTC', 'Pacific/Kiritimati', 'America/Anchorage']

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function inZone<T>(timeZone: string, run: () => T): T {
    vi.stubEnv('TZ', timeZone)
    try {
      return run()
    } finally {
      vi.unstubAllEnvs()
    }
  }

  // Monday 2026-06-08 at UTC midnight: Sunday the 7th in Anchorage, and already
  // Monday afternoon of the 8th... in Kiritimati it is 14:00 on the 8th.
  const MONDAY = '2026-06-08T00:00:00.000Z'

  it('labels the week bucket by its Monday in every zone', () => {
    for (const timeZone of ZONES) {
      expect(inZone(timeZone, () => formatTooltipLabel(MONDAY, 'week')))
        .toBe('Week of Jun 8, 2026')
      expect(inZone(timeZone, () => formatTick(MONDAY, 'week'))).toBe('Jun 8')
    }
  })

  it('labels a day bucket by its UTC date in every zone', () => {
    for (const timeZone of ZONES) {
      expect(inZone(timeZone, () => formatTooltipLabel(MONDAY, 'day'))).toBe('Jun 8, 2026')
      expect(inZone(timeZone, () => formatTick(MONDAY, 'day'))).toBe('Jun 8')
    }
  })

  it('labels an hour bucket by its UTC hour in every zone', () => {
    // 23:00 UTC is the next local day east of Greenwich and the same local day
    // (14:00) west of it — the label must not drift either way.
    const lateHour = '2026-06-07T23:00:00.000Z'
    for (const timeZone of ZONES) {
      expect(inZone(timeZone, () => formatTooltipLabel(lateHour, 'hour')))
        .toBe('Jun 7, 11:00 PM')
      expect(inZone(timeZone, () => formatTick(lateHour, 'hour'))).toBe('Jun 7, 11 PM')
    }
  })

  it('labels a month bucket by its UTC month in every zone', () => {
    // The first instant of July UTC is still June 30 in Anchorage.
    const july = '2026-07-01T00:00:00.000Z'
    for (const timeZone of ZONES) {
      expect(inZone(timeZone, () => formatTooltipLabel(july, 'month'))).toBe('July 2026')
      expect(inZone(timeZone, () => formatTick(july, 'month'))).toBe('Jul 2026')
    }
  })
})

describe('formatCount', () => {
  it('renders 6-digit values compactly so labels stay short', () => {
    // The bug: "380.0k" (6 chars) clipped its left digits against a fixed axis.
    expect(formatCount(380_000)).toBe('380k')
    expect(formatCount(285_000)).toBe('285k')
    expect(formatCount(750_000)).toBe('750k')
  })

  it('escalates to M before a value would render as "1000k"', () => {
    expect(formatCount(1_500_000)).toBe('1.5M')
    expect(formatCount(1_000_000)).toBe('1M')
    expect(formatCount(999_500)).toBe('1M')
  })

  it('keeps small values verbatim and one decimal below 100 units', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(842)).toBe('842')
    expect(formatCount(1_500)).toBe('1.5k')
  })

  it('never exceeds 5 characters across the 100k–9.9M range', () => {
    for (const v of [100_000, 285_000, 380_000, 999_499, 1_500_000, 9_900_000]) {
      expect(formatCount(v).length).toBeLessThanOrEqual(5)
    }
  })

  it('rounds sub-1000 fractions instead of leaking float noise', () => {
    // A confidence-band bound times the 1.1 overshoot: raw String() would emit
    // "-0.9900000000000001" (19 chars) and blow out the Y-axis width.
    expect(formatCount(-0.9 * 1.1)).toBe('-1')
    expect(formatCount(0.11000000000000001)).toBe('0')
    expect(formatCount(842.6)).toBe('843')
    expect(formatCount(-0.9 * 1.1).length).toBeLessThanOrEqual(3)
  })
})

describe('axisWidthForValues', () => {
  it('reserves more width for wide count labels than for small ones', () => {
    const narrow = axisWidthForValues([0, 10, 80], formatCount)
    const wide = axisWidthForValues([0, 285_000, 380_000], formatCount)
    expect(wide).toBeGreaterThan(narrow)
  })

  it('sizes the axis through a caller-supplied formatter (percent units)', () => {
    const pct = (v: number) => `${Math.round(v * 100)}%`
    const width = axisWidthForValues([0, 0.08, 0.05], pct)
    // "8%"/"5%" are short — axis stays near the floor, not blown out.
    expect(width).toBeGreaterThanOrEqual(40)
    expect(width).toBeLessThan(axisWidthForValues([0, 285_000], formatCount))
  })

  it('falls back to the minimum width for an empty series', () => {
    expect(axisWidthForValues([], formatCount)).toBe(40)
  })

  it('does not blow out when the min is a small negative fraction', () => {
    // Regression: the Structured Event tab fed a band lower bound of ~-0.9, and
    // min*1.1 float noise reserved a ~140px axis that shoved the plot right.
    const width = axisWidthForValues([-0.9, 550_000, 2_300_000], formatCount)
    expect(width).toBeLessThanOrEqual(64)
  })

  it('clamps pathological (non-finite / oversized) labels to the max width', () => {
    expect(axisWidthForValues([0, Infinity, NaN, 2_300_000], formatCount)).toBeLessThanOrEqual(80)
    const huge = (v: number) => `${v}`.padStart(40, '0')
    expect(axisWidthForValues([0, 1, 2], huge)).toBe(80)
  })
})
