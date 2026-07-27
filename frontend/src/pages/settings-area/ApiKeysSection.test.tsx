import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeysApi } from '@/api/apiKeys'
import { projectsApi } from '@/api/projects'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import type { ApiKey } from '@/types'
import ApiKeysSection from './ApiKeysSection'

function ownerAuthValue(): AuthContextValue {
  return {
    user: {
      id: 'owner-1',
      email: 'owner@example.com',
      name: 'owner',
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
}

function key(overrides: Partial<ApiKey> & { id: string; name: string }): ApiKey {
  return {
    key_prefix: 'trpl_abc',
    scope: 'read',
    project_id: null,
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={ownerAuthValue()}>
        <MemoryRouter initialEntries={['/settings/workspace/api-keys']}>
          <ApiKeysSection />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ApiKeysSection', () => {
  it('reveals the New API key form above the Active keys card on "Create key"', async () => {
    vi.spyOn(apiKeysApi, 'list').mockResolvedValue([])
    vi.spyOn(projectsApi, 'list').mockResolvedValue([])

    renderSection()

    expect(screen.queryByText('New API key')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Create key/i }))

    const formTitle = await screen.findByText('New API key')
    const keyListTitle = screen.getByText('All keys')

    // The form must render above the key list card so it appears right where
    // the user clicked, not below the fold (regression: tripl-grjv).
    expect(
      formTitle.compareDocumentPosition(keyListTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    // The revealed form focuses the key-name input immediately.
    expect(screen.getByLabelText('Name')).toHaveFocus()
  })

  // The card used to headline "Active keys · 10 keys" from the unfiltered list,
  // so revoked and expired tokens were counted as live ones (tripl-jfm3.33).
  it('counts only usable keys in the card heading and names the dead ones', async () => {
    vi.spyOn(apiKeysApi, 'list').mockResolvedValue([
      key({ id: 'k1', name: 'codex' }),
      key({ id: 'k2', name: 'claude' }),
      key({ id: 'k3', name: 'ro', revoked_at: '2026-05-01T00:00:00Z' }),
      key({ id: 'k4', name: 'admin', revoked_at: '2026-05-02T00:00:00Z' }),
      key({ id: 'k5', name: 'stale', expires_at: '2026-01-01T00:00:00Z' }),
    ])
    vi.spyOn(projectsApi, 'list').mockResolvedValue([])

    renderSection()

    expect(await screen.findByText('2 active · 3 revoked or expired')).toBeInTheDocument()
    expect(screen.queryByText('Active keys')).not.toBeInTheDocument()
    expect(screen.queryByText('5 keys')).not.toBeInTheDocument()
  })
})
