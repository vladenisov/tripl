import { describe, expect, it } from 'vitest'
import { formatPlanCoverage, planCoverageRatio } from './coverage'

describe('formatPlanCoverage', () => {
  it('formats a partial plan to one decimal place', () => {
    expect(formatPlanCoverage(320, 323)).toBe('99.1%')
  })

  it('shows a clean "100%" only when every active event is implemented', () => {
    expect(formatPlanCoverage(323, 323)).toBe('100%')
  })

  it('shows "100%" when implemented exceeds active', () => {
    expect(formatPlanCoverage(330, 323)).toBe('100%')
  })

  it('returns "0%" when there are no active events', () => {
    expect(formatPlanCoverage(0, 0)).toBe('0%')
  })

  it('never reports a partial plan as "100%"', () => {
    expect(formatPlanCoverage(322, 323)).not.toBe('100%')
    expect(formatPlanCoverage(322, 323)).toBe('99.7%')
  })

  it('clamps a value that would round up to 100.0 down to "99.9%"', () => {
    // 9995 / 10000 = 99.95%, which toFixed(1) rounds to "100.0".
    expect(formatPlanCoverage(9995, 10000)).toBe('99.9%')
  })
})

describe('planCoverageRatio', () => {
  it('returns the implemented/active ratio for a partial plan', () => {
    expect(planCoverageRatio(320, 323)).toBeCloseTo(0.990712, 5)
  })

  it('returns 1 for a fully implemented plan', () => {
    expect(planCoverageRatio(323, 323)).toBe(1)
  })

  it('returns 0 when there are no active events', () => {
    expect(planCoverageRatio(0, 0)).toBe(0)
  })
})
