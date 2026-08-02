import { describe, expect, it } from 'vitest'

import { readableTextOn } from './contrast'

const AA_BODY = 4.5

function luminance(hex: string): number {
  const n = hex.replace('#', '')
  const ch = (i: number) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4)
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('readableTextOn', () => {
  // The three that shipped unreadable: a hardcoded white label on the
  // event-type colour measured 4.46 / 2.27 / 2.14 against these.
  it.each([
    ['#6366f1', 'indigo-500'],
    ['#22c55e', 'green-500'],
    ['#f59e0b', 'amber-500'],
  ])('clears AA on %s (%s)', (color) => {
    const measured = ratio(readableTextOn(color), color)
    expect(measured, `measured ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY)
  })

  it('clears AA on every colour the picker can produce', () => {
    // Exhaustive on a coarse grid: black and white are closest around a
    // background luminance of ~0.179, where the guarantee is tightest.
    const worst = { color: '', ratio: Infinity }
    for (let r = 0; r <= 255; r += 15) {
      for (let g = 0; g <= 255; g += 15) {
        for (let b = 0; b <= 255; b += 15) {
          const color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
          const measured = ratio(readableTextOn(color), color)
          if (measured < worst.ratio) {
            worst.color = color
            worst.ratio = measured
          }
        }
      }
    }
    expect(
      worst.ratio,
      `worst case ${worst.color} measured ${worst.ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY)
  })

  it('picks black on light backgrounds and white on dark ones', () => {
    expect(readableTextOn('#ffff00')).toBe('#000000')
    expect(readableTextOn('#000080')).toBe('#ffffff')
  })

  it('accepts shorthand hex', () => {
    expect(readableTextOn('#fff')).toBe('#000000')
    expect(readableTextOn('#000')).toBe('#ffffff')
  })

  it('falls back to white for values it cannot parse', () => {
    // Named colours, rgb() and CSS variables are the caller's business — the
    // fallback keeps the previous behaviour rather than inventing one.
    for (const value of [null, undefined, '', 'rebeccapurple', 'var(--accent)', '#12345']) {
      expect(readableTextOn(value)).toBe('#ffffff')
    }
  })
})
