import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sparkline } from './sparkline'

function linePoints(container: HTMLElement): Array<[number, number]> {
  // The stroked path is the last <path>; the first one is the area fill.
  const paths = container.querySelectorAll('path')
  const d = paths[paths.length - 1]?.getAttribute('d') ?? ''
  return Array.from(d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g), (match) => [
    Number(match[1]),
    Number(match[2]),
  ])
}

function barHeights(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('rect'), (rect) => Number(rect.getAttribute('height')))
}

// DS-4: the range was clamped to at least 1 unit, so a percent metric stored as
// a fraction (0.05 → 0.09) drew under a pixel of travel — a flat line.
describe('Sparkline scaling', () => {
  it('uses the full height for a fractional series', () => {
    const { container } = render(<Sparkline data={[0.05, 0.07, 0.09]} height={22} />)
    const ys = linePoints(container).map(([, y]) => y)
    expect(ys).toHaveLength(3)
    // 2px padding top and bottom: the lowest value sits at 20, the highest at 2.
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(18)
  })

  it('draws a flat series flat without dividing by zero', () => {
    const { container } = render(<Sparkline data={[0.3, 0.3, 0.3]} height={22} />)
    const ys = linePoints(container).map(([, y]) => y)
    expect(ys.every((y) => Number.isFinite(y))).toBe(true)
    expect(new Set(ys).size).toBe(1)
  })

  it('stands bars on zero so the smallest is not a 1px stub', () => {
    const { container } = render(
      <Sparkline data={[100, 200]} variant="bar" width={40} height={22} />,
    )
    const [small, large] = barHeights(container)
    // 100 of 200 is half the drawable height (20px), not the 1px minimum.
    expect(small).toBeCloseTo(10)
    expect(large).toBeCloseTo(20)
  })

  it('scales fractional bars too', () => {
    const { container } = render(
      <Sparkline data={[0.02, 0.04]} variant="bar" width={40} height={22} />,
    )
    const [small, large] = barHeights(container)
    expect(large).toBeCloseTo(20)
    expect(small).toBeCloseTo(10)
  })
})
