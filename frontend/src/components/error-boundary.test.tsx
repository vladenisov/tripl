import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './error-boundary'

const INTERNAL_MESSAGE = 'INTERNAL_FAILURE_secretStackDetail'

function Boom(): never {
  throw new Error(INTERNAL_MESSAGE)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('shows only a friendly fallback and never leaks the raw error string', () => {
    // React itself logs caught render errors to console.error; silence it so the
    // test output stays clean while we still assert our own diagnostic log.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()

    // The internal error message (function names / stack detail) must not be
    // rendered anywhere in the visible UI.
    expect(screen.queryByText(new RegExp(INTERNAL_MESSAGE))).not.toBeInTheDocument()

    // ...but the raw error is still logged to console.error for developers.
    const loggedRaw = consoleError.mock.calls.some(call =>
      call.some(arg => arg instanceof Error && arg.message === INTERNAL_MESSAGE),
    )
    expect(loggedRaw).toBe(true)
  })
})
