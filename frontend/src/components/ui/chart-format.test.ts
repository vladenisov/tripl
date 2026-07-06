import { describe, expect, it } from 'vitest'
import { axisWidthForValues, formatCount } from './chart-format'

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
})
