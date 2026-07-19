import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductTour } from './ProductTour'
import { buildTourSteps } from './tourSteps'

// Derived, not hardcoded: adding a tour step must not break these tests.
const TOTAL_STEPS = buildTourSteps('acme').length
const LAST_INDEX = TOTAL_STEPS - 1

function renderTour(onOpenChange: (open: boolean) => void = () => {}) {
  return render(
    <MemoryRouter>
      <ProductTour slug="acme" open onOpenChange={onOpenChange} />
    </MemoryRouter>,
  )
}

afterEach(() => {
  window.localStorage.clear()
})

describe('ProductTour — progress survives the navigation it asks for (tripl-2su6.18)', () => {
  it('advances and remembers the step when you open its surface', () => {
    // Every step deep-links to a real surface, so following the tour necessarily
    // closes the dialog. It used to reset to step one on close, which made the
    // sequence impossible to follow: going to step 1's surface and reopening put
    // you back on step 1 forever.
    const onOpenChange = vi.fn()
    const { unmount } = renderTour(onOpenChange)

    expect(screen.getByText(/^Step 1 of/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: /open events & tracking plan/i }))

    // Visiting the surface is progress, and it closes the dialog.
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(window.localStorage.getItem('tripl-tour:acme')).toBe('1')

    // Reopening (a fresh mount, as after navigating) resumes on the NEXT step.
    unmount()
    renderTour()
    expect(screen.getByText(/^Step 2 of/)).toBeInTheDocument()
  })

  it('keeps your place when the dialog is merely dismissed', () => {
    renderTour()
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(screen.getByText(/^Step 2 of/)).toBeInTheDocument()
    expect(window.localStorage.getItem('tripl-tour:acme')).toBe('1')
  })

  it('starts over once the tour is finished', () => {
    window.localStorage.setItem('tripl-tour:acme', String(LAST_INDEX))
    const { unmount } = renderTour()

    expect(screen.getByText(new RegExp(`^Step ${TOTAL_STEPS} of`))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^finish$/i }))
    expect(window.localStorage.getItem('tripl-tour:acme')).toBe('0')

    unmount()
    renderTour()
    expect(screen.getByText(/^Step 1 of/)).toBeInTheDocument()
  })

  it('ignores a stored step that is out of range', () => {
    window.localStorage.setItem('tripl-tour:acme', '999')
    renderTour()
    expect(screen.getByText(/^Step 1 of/)).toBeInTheDocument()
  })
})

describe('ProductTour', () => {
  it('opens on the first step and links it to the real surface', () => {
    renderTour()

    expect(
      screen.getByText(`Step 1 of ${TOTAL_STEPS} · a quick guided path through tripl.`),
    ).toBeInTheDocument()
    const open = screen.getByRole('link', { name: /open events & tracking plan/i })
    expect(open).toHaveAttribute('href', '/p/acme/events')
  })

  it('advances through the steps', () => {
    renderTour()
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(screen.getByText(new RegExp(`Step 2 of ${TOTAL_STEPS}`))).toBeInTheDocument()
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

    // Each building block deep-links to the surface that actually shows it —
    // they used to share one bare /p/acme/metrics href (tripl-2su6.19).
    const href = (name: string) =>
      screen.getByRole('link', { name: new RegExp(`^${name}$`, 'i') }).getAttribute('href')

    expect(href('Fact tables')).toBe('/p/acme/metrics/fact-tables')
    expect(href('Fact')).toBe('/p/acme/metrics?kind=fact')
    expect(href('SQL')).toBe('/p/acme/metrics?kind=sql')
    expect(href('Event composition')).toBe('/p/acme/metrics?kind=event_composition')
    // Event volume is a scan-collected per-event series, not a catalog kind.
    expect(href('Event volume')).toBe('/p/acme/events')
  })

  it('offers a Finish action on the final step in place of Next', () => {
    renderTour()
    // Step to the end (N steps → N-1 advances).
    for (let i = 0; i < LAST_INDEX; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    }
    expect(screen.queryByRole('button', { name: /^next$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /finish/i })).toBeInTheDocument()
  })
})
