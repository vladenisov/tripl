import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MiniStat, MiniStatStrip } from './mini-stat'

// MON-42: `tone` with no delta used to render nothing, while the call sites
// (Overview's Implemented / Needs review / Coverage, the Coverage page) read as
// if their figures were coloured.
describe('MiniStat tone', () => {
  it('tints the figure when there is no delta to carry the tone', () => {
    render(<MiniStat label="Coverage" value="92%" tone="success" />)
    expect(screen.getByText('92%')).toHaveAttribute('data-tone', 'success')
  })

  it('keeps the figure plain and tones the delta when there is one', () => {
    render(<MiniStat label="Active scopes" value="4" delta="1 firing" tone="danger" />)
    expect(screen.getByText('4')).not.toHaveAttribute('data-tone')
    expect(screen.getByText('1 firing')).toHaveStyle({ color: 'var(--danger)' })
  })

  it('lets valueTone colour the figure beside a delta', () => {
    render(<MiniStat label="Spikes" value="3" delta="+1" tone="neutral" valueTone="danger" />)
    expect(screen.getByText('3')).toHaveAttribute('data-tone', 'danger')
  })

  it('never tints a neutral figure', () => {
    render(<MiniStat label="Events" value="12" tone="neutral" />)
    expect(screen.getByText('12')).not.toHaveAttribute('data-tone')
  })
})

// LIVE-8: the divider was a sibling element, so a wrapped row ended with one.
describe('MiniStatStrip', () => {
  it('gives every stat but the first its own divider', () => {
    const { container } = render(
      <MiniStatStrip>
        <MiniStat label="A" value="1" />
        {false}
        <MiniStat label="B" value="2" />
        {null}
        <MiniStat label="C" value="3" />
      </MiniStatStrip>,
    )
    // Three stats, two dividers; skipped children leave no stray divider.
    expect(screen.getAllByRole('term')).toHaveLength(3)
    expect(container.querySelectorAll('[data-slot="mini-stat-divider"]')).toHaveLength(2)
    for (const divider of container.querySelectorAll('[data-slot="mini-stat-divider"]')) {
      expect(divider).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('applies the caller box styling to the outer element', () => {
    const { container } = render(
      <MiniStatStrip className="rounded-lg border" style={{ background: 'var(--bg-sunken)' }}>
        <MiniStat label="A" value="1" />
      </MiniStatStrip>,
    )
    expect(container.firstElementChild).toHaveStyle({ background: 'var(--bg-sunken)' })
    expect(container.querySelector('[data-slot="mini-stat-divider"]')).toBeNull()
  })

  // A vertical clip cut the top and bottom of a filter toggle's focus ring.
  it('clips the row-start dividers sideways only, never vertically', () => {
    const { container } = render(
      <MiniStatStrip>
        <MiniStat label="A" value="1" />
        <MiniStat label="B" value="2" />
      </MiniStatStrip>,
    )
    const clip = container.querySelector<HTMLElement>('[data-slot="mini-stat-clip"]')
    expect(clip).not.toBeNull()
    expect(clip?.style.overflowX).toBe('clip')
    expect(clip?.style.overflowY).toBe('visible')
    expect(clip?.className).not.toMatch(/overflow-(hidden|clip|auto|scroll)|overflow-y-/)
  })
})

// LIVE-23: an info icon placed beside the whole stat sat far from its caption.
describe('MiniStat labelAddon', () => {
  it('renders the addon inside the caption', () => {
    render(
      <MiniStat label="Chart signals" value="3" labelAddon={<button type="button" aria-label="About chart signals" />} />,
    )
    const caption = screen.getByRole('term')
    expect(caption).toHaveTextContent('Chart signals')
    expect(caption).toContainElement(screen.getByRole('button', { name: 'About chart signals' }))
  })
})

// DS-17: a KPI figure is a number, not code.
describe('MiniStat figure', () => {
  it('sets the value in sans with tabular digits, never mono', () => {
    render(<MiniStat label="Last run" value="1h ago" />)
    const value = screen.getByText('1h ago')
    expect(value).toHaveClass('tnum')
    expect(value).not.toHaveClass('mono')
    expect(value).not.toHaveClass('font-mono')
  })
})

// DS-5: one page-KPI container instead of each page spelling it out.
describe('MiniStatStrip boxed', () => {
  it('draws the sunken card box when boxed', () => {
    const { container } = render(
      <MiniStatStrip boxed>
        <MiniStat label="A" value="1" />
      </MiniStatStrip>,
    )
    const strip = container.querySelector('[data-slot="mini-stat-strip"]')
    expect(strip).toHaveClass('rounded-card', 'border', 'bg-bg-sunken', 'px-4', 'py-3')
  })

  it('draws no box by default', () => {
    const { container } = render(
      <MiniStatStrip>
        <MiniStat label="A" value="1" />
      </MiniStatStrip>,
    )
    const strip = container.querySelector('[data-slot="mini-stat-strip"]')
    expect(strip).not.toHaveClass('rounded-card')
    expect(strip).not.toHaveClass('bg-bg-sunken')
  })
})
