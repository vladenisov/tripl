import { describe, expect, it } from 'vitest'

import { formatPercentDelta } from './percentDelta'

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
