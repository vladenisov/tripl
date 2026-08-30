import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import UsersPage from './UsersPage'

const OWNER: AuthContextValue = {
  user: {
    id: 'owner-1',
    email: 'owner@example.com',
    name: 'Owner',
    role: 'owner',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  status: 'authenticated',
  error: null,
  isLoggingOut: false,
  logout: async () => {},
  refresh: () => {},
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const INVITATION = {
  id: 'inv-1',
  email: 'newcomer@example.com',
  role: 'editor',
  expires_at: '2026-09-01T00:00:00Z',
  is_expired: false,
}

function renderUsersPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={OWNER}>
        <MemoryRouter>
          <UsersPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UsersPage', () => {
  it('surfaces a failed users fetch instead of claiming the instance is empty', async () => {
    // A page that by definition contains at least its reader used to answer a
    // failed fetch with "No users yet." — no error, no retry, nowhere to go.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      if (urlOf(input).endsWith('/api/v1/users')) {
        return Promise.resolve(jsonResponse({ detail: 'boom' }, 500))
      }
      return Promise.resolve(jsonResponse([]))
    })

    renderUsersPage()

    expect(await screen.findByText("Couldn't load users")).toBeInTheDocument()
    expect(screen.queryByText('No users yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry|try again/i })).toBeInTheDocument()
  })

  it('asks before revoking an invitation, because the link cannot be reissued', async () => {
    const revoked: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input)
        if (url.endsWith('/api/v1/users')) return Promise.resolve(jsonResponse([]))
        if (url.endsWith('/api/v1/users/invitations') && !init?.method) {
          return Promise.resolve(jsonResponse([INVITATION]))
        }
        if (init?.method === 'DELETE') {
          revoked.push(url)
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        return Promise.reject(new Error(`Unexpected request: ${url}`))
      },
    )

    renderUsersPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))

    expect(await screen.findByText('Revoke invitation')).toBeInTheDocument()
    expect(revoked).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByText('Revoke invitation')).not.toBeInTheDocument()
    })
    expect(revoked).toEqual([])
  })
})
