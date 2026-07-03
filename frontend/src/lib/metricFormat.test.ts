import { describe, expect, it } from 'vitest'
import { formatMetricValue, isPercentUnit, metricAxisFormatter } from './metricFormat'

describe('isPercentUnit', () => {
  it('is true for "%" including surrounding whitespace', () => {
    expect(isPercentUnit('%')).toBe(true)
    expect(isPercentUnit(' % ')).toBe(true)
  })

  it('is false for other units, empty, null, and undefined', () => {
    expect(isPercentUnit('ms')).toBe(false)
    expect(isPercentUnit('pct')).toBe(false)
    expect(isPercentUnit('')).toBe(false)
    expect(isPercentUnit(null)).toBe(false)
    expect(isPercentUnit(undefined)).toBe(false)
  })
})

describe('formatMetricValue', () => {
  it('renders an em dash for null and undefined', () => {
    expect(formatMetricValue(null, '%')).toBe('—')
    expect(formatMetricValue(undefined, null)).toBe('—')
  })

  it('multiplies percent-unit fractions by 100', () => {
    expect(formatMetricValue(0.08, '%')).toBe('8 %')
    expect(formatMetricValue(0.0812, '%')).toBe('8.12 %')
    expect(formatMetricValue(0.5, '%')).toBe('50 %')
  })

  it('rounds percent displays >= 100 to whole numbers', () => {
    // 1.056 → 105.6 % → whole-number rounding above the 100 threshold.
    expect(formatMetricValue(1.056, '%')).toBe('106 %')
    // Locale-safe: grouping of large numbers matches toLocaleString.
    expect(formatMetricValue(42, '%')).toBe(`${(4200).toLocaleString()} %`)
  })

  it('keeps the historical catalog behavior for non-percent units', () => {
    expect(formatMetricValue(0.08, 'ratio')).toBe('0.08 ratio')
    expect(formatMetricValue(12.346, null)).toBe('12.35')
    expect(formatMetricValue(1234.56, 'ms')).toBe(`${(1235).toLocaleString()} ms`)
  })
})

describe('metricAxisFormatter', () => {
  it('formats percent ticks compactly ×100', () => {
    const format = metricAxisFormatter('%')
    expect(format(0.08)).toBe('8%')
    expect(format(0.005)).toBe('0.5%')
    expect(format(1.5)).toBe('150%')
  })

  it('keeps the chart default compact-count behavior without a unit', () => {
    const format = metricAxisFormatter(null)
    expect(format(8)).toBe('8')
    expect(format(0.05)).toBe('0.05')
    expect(format(1500)).toBe('1.5k')
    expect(format(2_500_000)).toBe('2.5M')
  })

  it('treats non-percent units the same as no unit', () => {
    expect(metricAxisFormatter('ms')(1500)).toBe('1.5k')
  })
})
