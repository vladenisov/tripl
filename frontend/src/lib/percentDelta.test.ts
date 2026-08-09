import { describe, expect, it } from 'vitest'

import { formatPercentDelta, formatRatioDelta, ratioDelta } from './percentDelta'

describe('formatPercentDelta', () => {
  it('keeps one decimal and the sign-free percentage when there is a baseline', () => {
    expect(formatPercentDelta(70, 40)).toBe('70.0%')
    expect(formatPercentDelta(875.6, 20.5)).toBe('875.6%')
  })

  it('says there was no baseline instead of printing the undefined ratio', () => {
    // A scope that fired 137 times against a baseline of 0 stores percent_delta
    // 0.0 — the largest possible relative move written as the smallest.
    expect(formatPercentDelta(0, 0)).toBe('no baseline')
  })

  it('treats a fractional baseline as a baseline', () => {
    // Catalog metrics deliver sub-unit expectations; only exactly 0 is "none".
    expect(formatPercentDelta(350, 0.2)).toBe('350.0%')
  })
})

describe('ratioDelta', () => {
  it('is the signed percentage the value moved against its baseline', () => {
    expect(ratioDelta(200, 100)).toBe(100)
    expect(ratioDelta(50, 100)).toBe(-50)
  })

  it('is null when there is no baseline to divide by', () => {
    // The class the detector admits on purpose: something fired where nothing
    // was expected. The ratio is undefined, not zero.
    expect(ratioDelta(137, 0)).toBeNull()
    // A negative expectation is not a baseline either.
    expect(ratioDelta(137, -1)).toBeNull()
  })

  it('treats a fractional baseline as a baseline', () => {
    expect(ratioDelta(0.6, 0.2)).toBeCloseTo(200)
  })
})

describe('formatRatioDelta', () => {
  it('signs the percentage and rounds to whole percent by default', () => {
    expect(formatRatioDelta(137.4)).toBe('+137%')
    expect(formatRatioDelta(-42.6)).toBe('-43%')
    expect(formatRatioDelta(12.3, 1)).toBe('+12.3%')
  })

  it('names the undefined ratio with the same words the alert message uses', () => {
    // Not '' — a blank reads as missing data, which is a different problem from
    // one that is undefined by definition.
    expect(formatRatioDelta(null)).toBe('no baseline')
  })
})
