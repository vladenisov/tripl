import { describe, expect, it } from 'vitest'
import { SENSITIVITY_OPTIONS, SENSITIVITY_STYLE, type Sensitivity } from './eventTypes'

describe('sensitivity lifecycle', () => {
  it('covers the five sensitivity levels in order', () => {
    expect(SENSITIVITY_OPTIONS.map((o) => o.value)).toEqual([
      'none',
      'pii',
      'phi',
      'financial',
      'secret',
    ])
  })

  it('has a canonical style for every non-none sensitivity', () => {
    for (const opt of SENSITIVITY_OPTIONS) {
      if (opt.value === 'none') continue
      const style = SENSITIVITY_STYLE[opt.value as Exclude<Sensitivity, 'none'>]
      expect(style.bg).toBeTruthy()
      expect(style.fg).toBeTruthy()
    }
  })

  it('matches the design mockup SENS_STYLE colors', () => {
    expect(SENSITIVITY_STYLE).toEqual({
      pii: { bg: 'oklch(0.7 0.17 15 / 0.16)', fg: 'oklch(0.8 0.16 15)' },
      phi: { bg: 'oklch(0.7 0.16 300 / 0.16)', fg: 'oklch(0.8 0.15 300)' },
      financial: { bg: 'oklch(0.78 0.15 75 / 0.16)', fg: 'oklch(0.84 0.13 75)' },
      secret: { bg: 'oklch(0.42 0.02 250)', fg: 'oklch(0.92 0.01 250)' },
    })
  })
})
