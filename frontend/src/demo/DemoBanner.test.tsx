import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import { BranchProvider } from '@/components/branch-context'
import { projectsApi } from '@/api/projects'
import { ApiError } from '@/api/client'
import { eventTypesKey, projectKey, projectsKey } from '@/lib/queryKeys'
import type { Project } from '@/types'
import { DemoBanner } from './DemoBanner'
import { DemoScenarioProvider } from './DemoScenarioProvider'
import { readScenarioState, writeScenarioState } from './scenarioModel'
import { liveLoopState } from './scenarioTestState'

const WELCOME_DISMISS_KEY = 'tripl-demo-welcome-dismissed:demo-1'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    name: 'Demo workspace',
    slug: 'demo-1',
    description: '',
    app_version_keep_releases: 5,
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
      alert_rule_count: 0,
      monitoring_signal_count: 0,
      firing_monitor_count: 0,
      open_incident_count: 0,
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
  queryClient?: QueryClient
} = {}) {
  const project = options.project ?? makeProject()
  const auth = options.auth ?? authValue({ id: 'creator-1', role: 'editor' })
  const initialPath = options.initialPath ?? `/p/${project.slug}/overview`
  const queryClient = options.queryClient ?? new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  // Wrapped in a real BranchProvider and a real DemoScenarioProvider, as the
  // banner is in the app Layout inside both — the reset path has to be able to
  // clear the persisted branch selection AND the chapter progress.
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[initialPath]}>
          <DemoScenarioProvider project={project} pollIntervalMs={10_000}>
            <BranchProvider slug={project.slug}>
              <DemoBanner project={project} />
              <LocationProbe />
            </BranchProvider>
          </DemoScenarioProvider>
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

  it('hides reset/delete from the creator once they are demoted to viewer', () => {
    // The backend gates both routes on EditorUserDep before it looks at the
    // creator, so the demoted creator's click could only ever answer 403.
    renderBanner({ auth: authValue({ id: 'creator-1', role: 'viewer' }) })

    expect(screen.queryByRole('button', { name: /^reset$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument()
  })

  it('shows reset/delete to a workspace owner even if they did not create the demo', () => {
    renderBanner({ auth: authValue({ id: 'owner-9', role: 'owner' }) })

    expect(screen.getByRole('button', { name: /^reset$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })
})

describe('DemoBanner — the way back into the guided onboarding (tripl-imco)', () => {
  it('restores the dismissed welcome panel and opens the tour', async () => {
    // Dismissing the welcome panel is one unconfirmed X directly under this
    // banner, and it used to remove the tour and the chapter picker for good:
    // nothing in the app ever cleared this key.
    window.localStorage.setItem(WELCOME_DISMISS_KEY, '1')
    renderBanner()

    fireEvent.click(screen.getByRole('button', { name: /Tour & chapters/i }))

    expect(window.localStorage.getItem(WELCOME_DISMISS_KEY)).toBeNull()
    expect(await screen.findByRole('dialog', { name: /Product tour/i })).toBeInTheDocument()
  })

  it('offers the way back to a viewer, who has no Reset to fall back on', () => {
    renderBanner({ auth: authValue({ id: 'someone-else', role: 'viewer' }) })

    expect(screen.getByRole('button', { name: /Tour & chapters/i })).toBeInTheDocument()
  })

  it('a re-seed clears the dismissal and the chapter progress with the data', async () => {
    // A reset that left every chapter "completed" and the panel dismissed gave
    // back a fresh dataset with no guidance and no way into any.
    window.localStorage.setItem(WELCOME_DISMISS_KEY, '1')
    writeScenarioState('demo-1', liveLoopState('live-loop/see-chart', { status: 'completed' }))
    const resetSpy = vi.spyOn(projectsApi, 'resetDemo').mockResolvedValue(makeProject())

    renderBanner()
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reset demo/i }))

    await waitFor(() => expect(resetSpy).toHaveBeenCalledWith('demo-1'))
    await waitFor(() => expect(window.localStorage.getItem(WELCOME_DISMISS_KEY)).toBeNull())
    expect(readScenarioState('demo-1').chapters['live-loop']).toEqual({
      status: 'active',
      step: 'live-loop/run-scan',
    })
  })
})

describe('DemoBanner — reset and delete failures (DEMO-4, DEMO-23)', () => {
  it('reports a failed reset, lets the user try again, and does not leave the page', async () => {
    const resetSpy = vi
      .spyOn(projectsApi, 'resetDemo')
      .mockRejectedValue(new ApiError('Demo reset failed', 500))

    renderBanner({ initialPath: '/p/demo-1/metrics/metric-99' })
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reset demo/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Demo reset failed')
    expect(resetSpy).toHaveBeenCalledTimes(1)
    // The progress dialog is gone and the controls are usable again.
    expect(screen.queryByRole('dialog', { name: /re-seeding demo workspace/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^reset$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled()
    // Nothing was replaced, so the page the user was on still exists.
    expect(screen.getByTestId('path')).toHaveTextContent('/p/demo-1/metrics/metric-99')
  })

  it('narrates a reset that is still running and locks both actions until it answers', async () => {
    vi.spyOn(projectsApi, 'resetDemo').mockReturnValue(new Promise<never>(() => {}))

    renderBanner()
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reset demo/i }))

    expect(
      await screen.findByRole('dialog', { name: /re-seeding demo workspace/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /resetting/i, hidden: true })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^delete$/i, hidden: true })).toBeDisabled()
  })

  it('clears the error on the next thing the user does (DEMO-23)', async () => {
    vi.spyOn(projectsApi, 'resetDemo').mockRejectedValue(new ApiError('Demo reset failed', 500))

    renderBanner()
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reset demo/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Demo reset failed')

    fireEvent.click(screen.getByRole('button', { name: /what’s simulated/i }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('does not caption a delete with the reset that failed before it', async () => {
    vi.spyOn(projectsApi, 'resetDemo').mockRejectedValue(new ApiError('Demo reset failed', 500))
    vi.spyOn(projectsApi, 'deleteDemo').mockRejectedValue(new ApiError('Demo delete refused', 409))

    renderBanner()
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reset demo/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Demo reset failed')

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /delete demo/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Demo delete refused'))
    expect(screen.queryByText('Demo reset failed')).not.toBeInTheDocument()
  })
})

describe('DemoBanner — what a reset drops from the cache (DEMO-3)', () => {
  it('drops the seeded data but keeps the session and the project the shell resolves', async () => {
    vi.spyOn(projectsApi, 'resetDemo').mockResolvedValue(makeProject())
    vi.spyOn(projectsApi, 'list').mockResolvedValue([makeProject()])
    vi.spyOn(projectsApi, 'get').mockResolvedValue(makeProject())
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const user = authValue({ id: 'creator-1', role: 'editor' }).user
    queryClient.setQueryData(['auth', 'me'], user)
    queryClient.setQueryData(projectsKey(), [makeProject()])
    queryClient.setQueryData(projectKey('demo-1'), makeProject())
    queryClient.setQueryData(eventTypesKey('demo-1', null), [{ id: 'old-seeded-row' }])

    renderBanner({ queryClient })
    fireEvent.click(screen.getByRole('button', { name: /^reset$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /reset demo/i }))

    await waitFor(() =>
      expect(queryClient.getQueryCache().find({ queryKey: eventTypesKey('demo-1', null) })).toBeUndefined(),
    )
    // Removing the session put the signed-in user back to 'loading' and
    // unmounted the whole app behind the route guard.
    expect(queryClient.getQueryData(['auth', 'me'])).toEqual(user)
    expect(queryClient.getQueryCache().find({ queryKey: projectsKey() })).toBeDefined()
    expect(queryClient.getQueryCache().find({ queryKey: projectKey('demo-1') })).toBeDefined()
  })
})
