import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MiniStat } from './mini-stat'

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
