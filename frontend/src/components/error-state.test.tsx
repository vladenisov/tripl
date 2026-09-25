import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ErrorState } from './error-state'

describe('ErrorState', () => {
  it('titles itself with an h2 by default', () => {
    render(<ErrorState title="Couldn't load events" error={new Error('boom')} />)
    expect(screen.getByRole('heading', { level: 2, name: "Couldn't load events" })).toBeInTheDocument()
  })

  // DS-16: inside a card that already has an h2, two sibling h2s flatten the
  // outline.
  it('takes a lower heading level when nested under a card title', () => {
    render(<ErrorState title="Couldn't load events" error={new Error('boom')} headingLevel={3} />)
    expect(screen.getByRole('heading', { level: 3, name: "Couldn't load events" })).toBeInTheDocument()
  })

  it('offers a retry button named by its label', () => {
    const onRetry = vi.fn()
    render(<ErrorState title="Failed" error={new Error('boom')} onRetry={onRetry} retryLabel="Retry" />)
    screen.getByRole('button', { name: 'Retry' }).click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
