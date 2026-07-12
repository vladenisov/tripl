import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import { BranchProvider } from '@/components/branch-context'
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
    demo_last_tick_at: null,
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
  initialPath?: string
} = {}) {
  const project = options.project ?? makeProject()
  const auth = options.auth ?? authValue({ id: 'creator-1', role: 'editor' })
  const initialPath = options.initialPath ?? `/p/${project.slug}/overview`
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Wrapped in a real BranchProvider, as the banner is in the app Layout — the
  // reset path has to be able to clear the persisted branch selection.
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[initialPath]}>
          <BranchProvider slug={project.slug}>
            <DemoBanner project={project} />
            <LocationProbe />
          </BranchProvider>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('DemoBanner', () => {
  it('labels the workspace as local synthetic data with its recipe version', () => {
    renderBanner()

    // Synthetic/local is never conflated with real/external data.
    expect(screen.getByText('Local synthetic data')).toBeInTheDocument()
    expect(screen.getByText('Demo workspace')).toBeInTheDocument()
    expect(screen.getByText('recipe v3')).toBeInTheDocument()
  })

  it('reports freshness from the runtime tick, not the seed time (tripl-2su6.17)', () => {
    // demo_seeded_at is floored to the hour, so a demo seeded at 10:59 carries
    // 10:00 and would read "refreshed 59m ago" the moment it appeared — and no
    // runtime tick ever moved it. Until the first tick there is nothing to claim.
    renderBanner({
      project: makeProject({ demo_seeded_at: '2026-07-10T00:00:00Z', demo_last_tick_at: null }),
    })
    expect(screen.getByText('freshly seeded')).toBeInTheDocument()
    expect(screen.queryByText(/updated/i)).not.toBeInTheDocument()
  })

  it('shows when the runtime tick last advanced the demo', () => {
    renderBanner({
      project: makeProject({ demo_last_tick_at: '2026-07-10T00:00:00Z' }),
    })
    expect(screen.getByText(/^updated /i)).toBeInTheDocument()
    expect(screen.queryByText('freshly seeded')).not.toBeInTheDocument()
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

  it('after reset, leaves the now-dead detail URL and drops the stored branch', async () => {
    // A re-seed recreates every entity with a NEW id, so the metric this page is
    // showing no longer exists, and the persisted branch id would make every
    // branch-aware query fail with "Branch not found" (tripl-2su6.14).
    window.localStorage.setItem('tripl-branch:demo-1', 'branch-abc')
    const resetSpy = vi.spyOn(projectsApi, 'resetDemo').mockResolvedValue(makeProject())

    renderBanner({ initialPath: '/p/demo-1/metrics/metric-99' })
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reset demo/i }))

    await waitFor(() => expect(resetSpy).toHaveBeenCalledWith('demo-1'))
    await waitFor(() =>
      expect(screen.getByTestId('path')).toHaveTextContent('/p/demo-1/overview'),
    )
    expect(window.localStorage.getItem('tripl-branch:demo-1')).toBeNull()
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
