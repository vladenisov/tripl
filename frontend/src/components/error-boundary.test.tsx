import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, RouteErrorBoundary } from './error-boundary'

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

  it('offers a reload, not a retry, when a lazy chunk failed to load', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    function ChunkGone(): never {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/Page-abc.js')
    }

    render(
      <ErrorBoundary>
        <ChunkGone />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('heading', { name: 'The app needs a reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Reload page/ })).toBeInTheDocument()
    // Retrying re-renders the cached rejected import, so it is not offered.
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument()
  })

  it('always offers a reload on the top-level fallback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: /Reload page/ })).toBeInTheDocument()
  })
})

describe('RouteErrorBoundary', () => {
  it('keeps the shell around a page that throws and clears on navigation', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <MemoryRouter initialEntries={['/broken']}>
        <nav>
          <Link to="/fine">Go elsewhere</Link>
        </nav>
        <RouteErrorBoundary>
          <Routes>
            <Route path="/broken" element={<Boom />} />
            <Route path="/fine" element={<p>Fine page</p>} />
          </Routes>
        </RouteErrorBoundary>
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'This page hit an error' })).toBeInTheDocument()
    // The shell's navigation outside the boundary is still there and usable.
    fireEvent.click(screen.getByRole('link', { name: 'Go elsewhere' }))

    expect(screen.getByText('Fine page')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
