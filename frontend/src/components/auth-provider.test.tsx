import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, AUTH_UNAUTHORIZED_EVENT } from '@/api/client'
import type { AuthUser } from '@/types'
import { AuthProvider } from './auth-provider'
import { useAuth } from './auth-context'

// Mock only the auth API (the thin wrapper over the client); the provider's
// reaction to the real AUTH_UNAUTHORIZED_EVENT is what we exercise here.
vi.mock('@/api/auth', () => ({
  authApi: {
    me: vi.fn(),
    logout: vi.fn(),
  },
}))

import { authApi } from '@/api/auth'

const meMock = vi.mocked(authApi.me)
const logoutMock = vi.mocked(authApi.logout)

function makeUser(): AuthUser {
  return { id: 'u-1', email: 'a@b.com', name: 'Ada' } as AuthUser
}

function Probe() {
  const { status, user } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? 'none'}</span>
    </div>
  )
}

function renderProvider() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  )
  return queryClient
}

beforeEach(() => {
  meMock.mockReset()
  logoutMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AuthProvider session status', () => {
  it('exposes authenticated status when /auth/me returns a user', async () => {
    meMock.mockResolvedValue(makeUser())
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'))
    expect(screen.getByTestId('email').textContent).toBe('a@b.com')
  })

  it('treats a 401 from /auth/me as anonymous (not error)', async () => {
    meMock.mockRejectedValue(new ApiError('Unauthorized', 401))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'))
  })

  it('treats a non-401 failure as an error status', async () => {
    meMock.mockRejectedValue(new ApiError('Boom', 500))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'))
  })
})

describe('AuthProvider unauthorized event cycle', () => {
  it('clears the session and re-fetches when AUTH_UNAUTHORIZED_EVENT fires', async () => {
    // First load authenticated, then the next /auth/me (after the event
    // invalidation) resolves anonymous.
    meMock.mockResolvedValueOnce(makeUser()).mockRejectedValueOnce(new ApiError('Unauthorized', 401))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'))

    // Simulate a 401 on a non-/auth path emitting the global event.
    window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT))

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'))
    expect(screen.getByTestId('email').textContent).toBe('none')
  })

  it('removes the event listener on unmount (no leak)', () => {
    meMock.mockRejectedValue(new ApiError('Unauthorized', 401))
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )
    unmount()
    expect(removeSpy).toHaveBeenCalledWith(AUTH_UNAUTHORIZED_EVENT, expect.any(Function))
    removeSpy.mockRestore()
  })
})
