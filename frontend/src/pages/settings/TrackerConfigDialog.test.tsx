import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { trackerConfigApi } from '@/api/trackerConfig'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import type { ProjectTrackerConfig, Role } from '@/types'
import { TrackerConfigDialog } from './TrackerConfigDialog'

vi.mock('@/api/trackerConfig', () => ({
  trackerConfigApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}))

function makeConfig(overrides: Partial<ProjectTrackerConfig> = {}): ProjectTrackerConfig {
  return {
    id: 't-1',
    project_id: 'p-1',
    enabled: true,
    tracker_type: 'jira',
    base_url: 'https://acme.atlassian.net',
    project_key: 'ENG',
    auth_email: 'ops@acme.com',
    issue_type: 'Task',
    api_token_set: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function authValue(role: Role): AuthContextValue {
  return {
    user: {
      id: `user-${role}`,
      email: `${role}@example.com`,
      name: role,
      role,
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

function renderDialog(role: Role = 'owner') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue(role)}>
        <TrackerConfigDialog slug="demo" open onOpenChange={() => {}} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('TrackerConfigDialog', () => {
  it('renders the section and loads an existing config with the stored-token hint', async () => {
    vi.mocked(trackerConfigApi.get).mockResolvedValue(makeConfig({ api_token_set: true }))

    renderDialog('owner')

    expect(await screen.findByText('Implementation tracker')).toBeInTheDocument()
    expect(
      await screen.findByText(/merging a branch opens one Jira ticket/i),
    ).toBeInTheDocument()

    // Existing values are seeded into the form.
    const baseUrl = await screen.findByLabelText('Base URL')
    expect(baseUrl).toHaveValue('https://acme.atlassian.net')
    expect(screen.getByLabelText('Project key')).toHaveValue('ENG')

    // The raw token is never returned, so the password field is empty and shows
    // the "leave blank to keep" hint.
    const token = screen.getByLabelText('API token')
    expect(token).toHaveValue('')
    expect(token).toHaveAttribute('placeholder', 'Token stored — leave blank to keep')
    expect(screen.getByText(/A token is stored\./i)).toBeInTheDocument()
  })

  it('saves a change via PATCH and omits api_token when the token field is blank', async () => {
    vi.mocked(trackerConfigApi.get).mockResolvedValue(makeConfig())
    vi.mocked(trackerConfigApi.update).mockResolvedValue(makeConfig({ project_key: 'PAY' }))

    renderDialog('owner')

    const projectKey = await screen.findByLabelText('Project key')
    fireEvent.change(projectKey, { target: { value: 'PAY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(trackerConfigApi.update).toHaveBeenCalledWith('demo', {
        enabled: true,
        base_url: 'https://acme.atlassian.net',
        project_key: 'PAY',
        auth_email: 'ops@acme.com',
        issue_type: 'Task',
      }),
    )
    // The blank token field must not be part of the payload.
    const [, payload] = vi.mocked(trackerConfigApi.update).mock.calls[0]
    expect(payload).not.toHaveProperty('api_token')
    expect(await screen.findByText('Tracker configuration saved.')).toBeInTheDocument()
  })

  it('includes api_token in the PATCH only when the user types one', async () => {
    vi.mocked(trackerConfigApi.get).mockResolvedValue(makeConfig({ api_token_set: false }))
    vi.mocked(trackerConfigApi.update).mockResolvedValue(makeConfig({ api_token_set: true }))

    renderDialog('owner')

    const token = await screen.findByLabelText('API token')
    fireEvent.change(token, { target: { value: 'super-secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(trackerConfigApi.update).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({ api_token: 'super-secret-token' }),
      ),
    )
  })

  it('hides the Save control and disables inputs for non-owners', async () => {
    vi.mocked(trackerConfigApi.get).mockResolvedValue(makeConfig())

    renderDialog('editor')

    // Editors can GET but not PATCH, so no Save affordance is offered.
    expect(await screen.findByLabelText('Project key')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Only project owners can edit the tracker connection.'),
    ).toBeInTheDocument()
  })

  it('surfaces a 403 from PATCH with a plain-language message', async () => {
    vi.mocked(trackerConfigApi.get).mockResolvedValue(makeConfig())
    vi.mocked(trackerConfigApi.update).mockRejectedValue(new ApiError('403 Forbidden', 403))

    renderDialog('owner')

    fireEvent.change(await screen.findByLabelText('Project key'), { target: { value: 'PAY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByText('Only project owners can change the tracker connection.'),
    ).toBeInTheDocument()
  })
})
