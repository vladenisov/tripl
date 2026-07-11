import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import { projectsApi } from '@/api/projects'
import type { Project } from '@/types'
import { DemoBanner } from './DemoBanner'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    name: 'Demo workspace',
    slug: 'demo-1',
    description: '',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    is_demo: true,
    generation_status: 'ready',
    demo_recipe_version: 'v3',
    demo_seeded_at: '2026-07-10T00:00:00Z',
    created_by_user_id: 'creator-1',
    summary: {
      event_type_count: 0,
      event_count: 0,
      active_event_count: 0,
      implemented_event_count: 0,
      review_pending_event_count: 0,
      archived_event_count: 0,
      variable_count: 0,
      scan_count: 0,
      alert_destination_count: 0,
      monitoring_signal_count: 0,
      firing_monitor_count: 0,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    },
    ...overrides,
  }
}

function authValue({ id, role }: { id: string; role: 'owner' | 'editor' | 'viewer' }): AuthContextValue {
  return {
    user: {
      id,
      email: `${id}@example.com`,
      name: id,
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

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="path">{location.pathname}</span>
}

function renderBanner(options: {
  project?: Project
  auth?: AuthContextValue
} = {}) {
  const project = options.project ?? makeProject()
  const auth = options.auth ?? authValue({ id: 'creator-1', role: 'editor' })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[`/p/${project.slug}/overview`]}>
          <DemoBanner project={project} />
          <LocationProbe />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DemoBanner', () => {
  it('labels the workspace as local synthetic data with recipe version and freshness', () => {
    renderBanner()

    // Synthetic/local is never conflated with real/external data.
    expect(screen.getByText('Local synthetic data')).toBeInTheDocument()
    expect(screen.getByText('Demo workspace')).toBeInTheDocument()
    expect(screen.getByText('recipe v3')).toBeInTheDocument()
    // Runtime freshness derived from demo_seeded_at.
    expect(screen.getByText(/refreshed/i)).toBeInTheDocument()
  })

  it('resets only after confirmation, via the demo-scoped endpoint', async () => {
    const resetSpy = vi.spyOn(projectsApi, 'resetDemo').mockResolvedValue(makeProject())

    renderBanner()
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))

    // A confirmation dialog gates the destructive action.
    const confirm = await screen.findByRole('button', { name: /reset demo/i })
    expect(resetSpy).not.toHaveBeenCalled()
    fireEvent.click(confirm)

    await waitFor(() => expect(resetSpy).toHaveBeenCalledWith('demo-1'))
  })

  it('deletes after confirmation and returns to the projects list', async () => {
    const deleteSpy = vi.spyOn(projectsApi, 'deleteDemo').mockResolvedValue(undefined as never)

    renderBanner()
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    const confirm = await screen.findByRole('button', { name: /delete demo/i })
    fireEvent.click(confirm)

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('demo-1'))
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/workspace'))
  })

  it('hides reset/delete from a non-creator, non-owner user', () => {
    renderBanner({ auth: authValue({ id: 'someone-else', role: 'viewer' }) })

    expect(screen.queryByRole('button', { name: /^reset$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
  })

  it('shows reset/delete to a workspace owner even if they did not create the demo', () => {
    renderBanner({ auth: authValue({ id: 'owner-9', role: 'owner' }) })

    expect(screen.getByRole('button', { name: /^reset$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })
})
