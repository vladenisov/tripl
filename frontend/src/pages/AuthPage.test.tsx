import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AuthPage from './AuthPage'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function urlOf(input: RequestInfo | URL) {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
}

// Default the unauthenticated /auth/status probe to a provisioned instance with
// registration open, so the owner note stays hidden and the sign-up tab stays
// visible unless a test opts into another instance shape.
function mockStatus(hasUsers: boolean, registrationEnabled = true) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.endsWith('/api/v1/auth/status')) {
      return Promise.resolve(
        jsonResponse({ has_users: hasUsers, registration_enabled: registrationEnabled }),
      )
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`))
  })
}

// Broader router that also answers the password-reset endpoints. Re-implements
// the (already-installed) fetch spy so tests can opt into the reset flows.
function mockAuthFetch(options: { emailConfigured?: boolean } = {}) {
  const emailConfigured = options.emailConfigured ?? true
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.endsWith('/api/v1/auth/status')) {
      return Promise.resolve(jsonResponse({ has_users: true, registration_enabled: true }))
    }
    if (url.endsWith('/api/v1/auth/password-reset/request')) {
      return Promise.resolve(
        jsonResponse({ message: 'neutral', email_configured: emailConfigured }),
      )
    }
    if (url.endsWith('/api/v1/auth/password-reset/confirm')) {
      return Promise.resolve(jsonResponse({ message: 'done' }))
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`))
  })
}

function renderAuth(initialEntry = '/auth') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AuthPage', () => {
  beforeEach(() => {
    mockStatus(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows sign-in copy in the card header by default (login mode)', () => {
    renderAuth()

    expect(
      screen.getByRole('heading', { name: 'Sign in to tripl' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Use your account to access the workspace and monitoring tools.'),
    ).toBeInTheDocument()
  })

  it('updates the card title and subtitle to registration copy when the register tab is active (UX-22)', () => {
    renderAuth()

    // The register tab is the only "Create account" control while login mode is active.
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(
      screen.getByRole('heading', { name: 'Create your tripl account' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Set up your account to start tracking coverage, monitoring drift, and routing alerts.',
      ),
    ).toBeInTheDocument()
    // Login-only copy is gone once registration mode is active.
    expect(
      screen.queryByRole('heading', { name: 'Sign in to tripl' }),
    ).not.toBeInTheDocument()
  })

  it('restores the sign-in copy when switching back to Existing Account', () => {
    renderAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Existing Account' }))

    expect(
      screen.getByRole('heading', { name: 'Sign in to tripl' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Create your tripl account' }),
    ).not.toBeInTheDocument()
  })

  it('gives the register tab and submit button distinct accessible names (UX .23)', () => {
    renderAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    // Tab and submit no longer collide on the same accessible name.
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create your account' })).toBeInTheDocument()
  })

  it('advertises the unified password policy on the register form (UX .11)', () => {
    renderAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    const password = screen.getByLabelText('Password') as HTMLInputElement
    expect(password.minLength).toBe(12)
    expect(
      screen.getByText('At least 12 characters, with a number and symbol.'),
    ).toBeInTheDocument()
  })

  it('exposes a forgot-password entry point in the login footer (UX .13)', () => {
    renderAuth()

    expect(
      screen.getByRole('button', { name: 'Forgot your password?' }),
    ).toBeInTheDocument()
    // The old static "contact your owner" copy is gone from the default footer —
    // it now only appears as a fallback after a request on an email-less instance.
    expect(
      screen.queryByText(/Contact your instance owner to reset/),
    ).not.toBeInTheDocument()
  })

  it('sends a reset request and shows a neutral confirmation when email is configured', async () => {
    mockAuthFetch({ emailConfigured: true })
    renderAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }))
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(
      await screen.findByText(/a password reset link is on its way/),
    ).toBeInTheDocument()
    // Neutral: it never states whether the account exists.
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument()
  })

  it('falls back to the contact-owner copy when the instance has no email configured', async () => {
    mockAuthFetch({ emailConfigured: false })
    renderAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }))
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(
      await screen.findByText(/Contact your instance owner to reset your password/),
    ).toBeInTheDocument()
  })

  it('enters reset mode from an emailed ?reset_token link and confirms a new password', async () => {
    mockAuthFetch()
    renderAuth('/auth?reset_token=tok-123')

    // The token in the URL switches the card straight into reset mode.
    expect(
      screen.getByRole('heading', { name: 'Choose a new password' }),
    ).toBeInTheDocument()

    const newPassword = screen.getByLabelText('New password') as HTMLInputElement
    expect(newPassword.minLength).toBe(12)

    fireEvent.change(newPassword, { target: { value: 'BrandNewPass9!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(
      await screen.findByText(/Your password has been reset/),
    ).toBeInTheDocument()
  })

  it('shows the first-account owner note only on a fresh instance in register mode (UX .13)', async () => {
    mockStatus(false)
    renderAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(
      await screen.findByText(/The first account on a new instance becomes the owner/),
    ).toBeInTheDocument()

    // The note is register-only: it disappears back in login mode.
    fireEvent.click(screen.getByRole('button', { name: 'Existing Account' }))
    expect(
      screen.queryByText(/The first account on a new instance becomes the owner/),
    ).not.toBeInTheDocument()
  })

  it('hides the owner note on a provisioned instance (UX .13)', async () => {
    renderAuth()

    // Let the /auth/status query settle (defaults to has_users: true).
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(
      screen.queryByText(/The first account on a new instance becomes the owner/),
    ).not.toBeInTheDocument()
  })

  it('offers no sign-up form when the instance has registration closed (tripl-jfm3.79)', async () => {
    mockStatus(true, false)
    renderAuth()

    // The policy is stated up front instead of being discovered from a 403 after
    // the visitor has filled in the form.
    expect(
      await screen.findByText(/Sign-ups are closed on this instance/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Create your account' }),
    ).not.toBeInTheDocument()
    // Signing in still works — only the sign-up half is withdrawn.
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
  })

  it('keeps the sign-up tab on an instance with registration open', async () => {
    renderAuth()

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())

    expect(
      await screen.findByRole('button', { name: 'Create account' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Sign-ups are closed on this instance/)).not.toBeInTheDocument()
  })
})
