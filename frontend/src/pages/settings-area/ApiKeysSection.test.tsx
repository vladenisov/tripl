import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiKeysApi } from '@/api/apiKeys'
import { projectsApi } from '@/api/projects'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
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
    const activeKeysTitle = screen.getByText('Active keys')

    // The form must render above the Active keys card so it appears right where
    // the user clicked, not below the fold (regression: tripl-grjv).
    expect(
      formTitle.compareDocumentPosition(activeKeysTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    // The revealed form focuses the key-name input immediately.
    expect(screen.getByLabelText('Name')).toHaveFocus()
  })
})
