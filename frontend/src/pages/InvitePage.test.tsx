import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvitePage from './InvitePage'
import { at } from '@/test/at'


function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function urlOf(input: RequestInfo | URL) {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

const TOKEN = 'invite-token-abc'

function renderInvitePage(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/invite/${TOKEN}`]}>
        <Routes>
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/" element={<div>Signed in home</div>} />
          <Route path="/auth" element={<div>Sign in screen</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InvitePage', () => {
  it('shows who the invitation is for and the role it grants', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.includes(`/auth/invitations/${TOKEN}`)) {
        return Promise.resolve(
          jsonResponse({
            email: 'invitee@example.com',
            role: 'editor',
            expires_at: '2026-08-01T00:00:00Z',
          }),
        )
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderInvitePage()

    expect(await screen.findByText('invitee@example.com')).toBeInTheDocument()
    expect(screen.getByText(/Editor/)).toBeInTheDocument()
    // The address is fixed by the invitation, so there must be no way to
    // redirect it to a different identity.
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument()
  })

  it('surfaces the single neutral error for an unusable link without guessing why', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.includes('/auth/invitations/')) {
        return Promise.resolve(
          jsonResponse({ detail: 'This invitation link is invalid, expired, or already used.' }, 400),
        )
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderInvitePage()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/invalid, expired, or already used/i)
    // No password form for a link that cannot be redeemed.
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it('accepts the invitation and lands the new user in the app', async () => {
    const accepted = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input)
        if (url.includes(`/auth/invitations/${TOKEN}/accept`)) {
          accepted(JSON.parse(String(init?.body)))
          return Promise.resolve(
            jsonResponse({ id: 'u1', email: 'invitee@example.com', role: 'editor' }, 201),
          )
        }
        if (url.includes(`/auth/invitations/${TOKEN}`)) {
          return Promise.resolve(
            jsonResponse({
              email: 'invitee@example.com',
              role: 'editor',
              expires_at: '2026-08-01T00:00:00Z',
            }),
          )
        }
        // No /auth/me: the accept response IS the session (SHELL-17).
        return Promise.reject(new Error(`Unexpected request: ${url}`))
      },
    )

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderInvitePage(qc)

    // The password policy is stated up front, not learned from a 422.
    const password = await screen.findByLabelText('Password')
    expect(password).toHaveAccessibleDescription('At least 12 characters, with a number and symbol.')
    expect(password).toHaveAttribute('autocomplete', 'new-password')

    fireEvent.change(password, {
      target: { value: 'Password123!' },
    })
    fireEvent.change(screen.getByLabelText(/Your name/i), { target: { value: 'New Person' } })
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }))

    await waitFor(() => expect(accepted).toHaveBeenCalled())
    // Only a password and a display name are ever submitted — never an address
    // or a role, which the server takes from the invitation.
    expect(at(accepted.mock.calls, 0)[0]).toEqual({ password: 'Password123!', name: 'New Person' })
    expect(await screen.findByText('Signed in home')).toBeInTheDocument()
    expect(qc.getQueryData(['auth', 'me'])).toEqual({
      id: 'u1',
      email: 'invitee@example.com',
      role: 'editor',
    })
  })
})
