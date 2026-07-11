import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ProductTour } from './ProductTour'

function renderTour() {
  return render(
    <MemoryRouter>
      <ProductTour slug="acme" open onOpenChange={() => {}} />
    </MemoryRouter>,
  )
}

describe('ProductTour', () => {
  it('opens on the first step and links it to the real surface', () => {
    renderTour()

    expect(screen.getByText('Step 1 of 10 · a quick guided path through tripl.')).toBeInTheDocument()
    const open = screen.getByRole('link', { name: /open events & tracking plan/i })
    expect(open).toHaveAttribute('href', '/p/acme/events')
  })

  it('advances through the steps', () => {
    renderTour()
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(screen.getByText(/Step 2 of 10/)).toBeInTheDocument()
  })

  it('exposes a direct index to every surface plus the metric building blocks', () => {
    renderTour()

    // Every surface is one click away regardless of stepper position.
    expect(screen.getByRole('link', { name: /^Scans$/i })).toHaveAttribute(
      'href',
      '/p/acme/settings/scans',
    )
    expect(screen.getByRole('link', { name: /^Branches$/i })).toHaveAttribute(
      'href',
      '/p/acme/settings/branches',
    )

    // Fact tables + the four metric kinds are directly discoverable.
    const factTables = screen.getByRole('link', { name: /^Fact tables$/i })
    expect(factTables).toHaveAttribute('href', '/p/acme/metrics/fact-tables')
    for (const kind of ['Event volume', 'Fact', 'SQL', 'Event composition']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${kind}$`, 'i') })).toHaveAttribute(
        'href',
        '/p/acme/metrics',
      )
    }
  })

  it('offers a Finish action on the final step in place of Next', () => {
    renderTour()
    // Step to the end (10 steps → 9 advances).
    for (let i = 0; i < 9; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    }
    expect(screen.queryByRole('button', { name: /^next$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /finish/i })).toBeInTheDocument()
  })
})
