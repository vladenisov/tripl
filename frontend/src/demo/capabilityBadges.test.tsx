import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DemoDataBadge, LocalDeliveryBadge, SyntheticSourceBadge } from './capabilityBadges'

describe('capability badges', () => {
  it('marks a simulated delivery as local — never as a real send', () => {
    render(<LocalDeliveryBadge simulated />)

    const badge = screen.getByText('Local · simulated')
    expect(badge).toBeInTheDocument()
    // The title makes it unmistakable nothing external happened.
    expect(badge).toHaveAttribute(
      'title',
      expect.stringContaining('nothing was sent to an external channel'),
    )
    // Must not carry the success (green) styling that a real "sent" badge uses.
    expect(badge.className).not.toMatch(/emerald|success/)
  })

  it('labels a synthetic source distinctly from a real connection', () => {
    render(<SyntheticSourceBadge />)

    const badge = screen.getByText('Synthetic')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveAttribute('title', expect.stringContaining('not a real connection'))
  })

  it('marks the workspace as local synthetic data', () => {
    render(<DemoDataBadge />)
    expect(screen.getByText('Local synthetic data')).toBeInTheDocument()
  })
})
