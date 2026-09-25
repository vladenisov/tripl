import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SecuritySection from './SecuritySection'

vi.mock('@/components/auth-context', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      role: 'editor',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    status: 'authenticated',
    error: null,
    isLoggingOut: false,
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}))

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SecuritySection />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Account · Security', () => {
  /**
   * The old card held an "Update password" button that did nothing (tripl-2o74)
   * and then told the reader to sign out and find "Forgot your password?".
   * The reset flow works, so the card runs it for the signed-in address (WS-37).
   */
  it('emails a reset link to the signed-in address', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ message: 'ok', email_configured: true }))
    renderSection()

    expect(screen.queryByRole('button', { name: 'Update password' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    expect(await screen.findByText(/check ada@example.com for a link/i)).toBeInTheDocument()
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toMatch(/\/auth\/password-reset\/request$/)
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'ada@example.com' })
  })

  it('says plainly when the instance cannot send the email', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ message: 'ok', email_configured: false }),
    )
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    expect(await screen.findByText(/cannot send email, so no link went out/i)).toBeInTheDocument()
  })

  it('shows a failed request in place', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ detail: 'Too many requests' }, 429),
    )
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Could not request a reset link/),
    )
  })

  /**
   * Two-factor and sessions were cards of switches nobody could move, one of
   * them "Strongly recommended for owners" (tripl-91j6), and a fabricated
   * device row. One card now names them, with nothing to click.
   */
  it('collapses the unbuilt protections into one card with no controls', () => {
    renderSection()

    expect(screen.getByText('Coming later')).toBeInTheDocument()
    expect(screen.getByText('Two-factor authentication')).toBeInTheDocument()
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByText(/recommended/i)).toBeNull()
    expect(screen.queryByText(/Current location/i)).toBeNull()
  })
})
