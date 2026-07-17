import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import ProjectsPage from './ProjectsPage'

function authValue(role: 'owner' | 'editor' | 'viewer'): AuthContextValue {
  return {
    user: {
      id: `${role}-1`,
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

function renderProjectsPage(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue(role)}>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('ProjectsPage', () => {
  it('shows portfolio metrics and project summaries', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'proj-1',
            name: 'Alpha',
            slug: 'alpha',
            description: 'Landing coverage and funnel events.',
            created_at: '2026-04-01T09:00:00Z',
            updated_at: '2026-04-10T09:00:00Z',
            summary: {
              event_type_count: 3,
              event_count: 8,
              active_event_count: 6,
              implemented_event_count: 4,
              review_pending_event_count: 2,
              archived_event_count: 2,
              variable_count: 5,
              scan_count: 2,
              alert_destination_count: 1,
              monitoring_signal_count: 2,
              failing_scan_config_count: 0,
              latest_scan_job: {
                id: 'job-1',
                scan_config_id: 'scan-1',
                scan_name: 'Production scan',
                status: 'completed',
                started_at: '2026-04-10T08:00:00Z',
                completed_at: '2026-04-10T08:05:00Z',
                result_summary: {
                  events_created: 4,
                  signals_added: 2,
                  alerts_queued: 1,
                },
                error_message: null,
                created_at: '2026-04-10T08:05:00Z',
              },
              latest_signal: {
                scan_config_id: 'scan-1',
                scan_name: 'Production scan',
                scope_type: 'event_type',
                scope_ref: 'type-1',
                scope_name: 'Page View',
                state: 'latest_scan',
                bucket: '2026-04-10T08:00:00Z',
                actual_count: 42,
                expected_count: 21,
                z_score: 7,
                direction: 'spike',
              },
            },
          },
        ]))
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'ds-1',
            name: 'Warehouse',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'analytics',
            username: 'default',
            password_set: false,
            connection_settings: {
              location: null,
              maximum_bytes_billed: null,
              dataset_allowlist: null,
              sslmode: null,
              sslrootcert: null,
              sslcert: null,
              search_path: null,
              sslkey_set: false,
            },
            created_at: '2026-04-01T09:00:00Z',
            updated_at: '2026-04-10T09:00:00Z',
          },
        ]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderProjectsPage()

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Analytics workspace')).toBeInTheDocument()
    expect(screen.getByText('Project portfolio')).toBeInTheDocument()
    expect(screen.getByText('Landing coverage and funnel events.')).toBeInTheDocument()
    expect(screen.getByText('66.7% implemented')).toBeInTheDocument()
    expect(screen.getByText('2 pending review')).toBeInTheDocument()
    expect(screen.getByText('Latest scan')).toBeInTheDocument()
    expect(screen.getByText('Production scan')).toBeInTheDocument()
    expect(screen.getByText('Latest scan signal')).toBeInTheDocument()
    expect(screen.getByText('Page View')).toBeInTheDocument()
    // H1: the dashboard recent-signal count never speaks of "active".
    expect(screen.getByText('2 recent')).toBeInTheDocument()
    expect(screen.queryByText('2 active')).not.toBeInTheDocument()
    expect(screen.getByText('Open Signal')).toBeInTheDocument()
    expect(screen.getByText('Open Project')).toBeInTheDocument()

    // UX-10: create-actions live in the header action area, not the stat strip.
    expect(screen.getByRole('button', { name: /New project/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate demo project/i })).toBeInTheDocument()
    // UX-10: each STATE metric is shown exactly once — no duplicated stat tiers.
    expect(screen.getAllByText('Projects')).toHaveLength(1)
    expect(screen.getAllByText('Coverage')).toHaveLength(1)
    expect(screen.getByText('Data sources')).toBeInTheDocument()
    expect(screen.getByText('Automation')).toBeInTheDocument()
    // UX-10: action-needed metrics each appear once, distinct from STATE metrics.
    expect(screen.getByText('Review queue')).toBeInTheDocument()
    expect(screen.getByText('Failed jobs')).toBeInTheDocument()
    expect(screen.getByText('Signals')).toBeInTheDocument()
  })

  it('hides project deletion from editors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'proj-1',
            name: 'Alpha',
            slug: 'alpha',
            description: '',
            created_at: '2026-04-01T09:00:00Z',
            updated_at: '2026-04-10T09:00:00Z',
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
              latest_scan_job: null,
              latest_signal: null,
            },
          },
        ]))
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderProjectsPage('editor')

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete Alpha/i })).not.toBeInTheDocument()
  })

  const RAW_SCAN_ERROR =
    "HTTPSConnectionPool(host='clickhouse.internal', port=8443): Read timed out. (read timeout=30)"

  function mockSingleProject() {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'proj-2',
            name: 'Beta',
            slug: 'beta',
            description: 'Near-complete plan with one failed scan.',
            created_at: '2026-05-01T09:00:00Z',
            updated_at: '2026-05-10T09:00:00Z',
            summary: {
              event_type_count: 4,
              event_count: 400,
              active_event_count: 323,
              implemented_event_count: 320,
              review_pending_event_count: 1,
              archived_event_count: 0,
              variable_count: 3,
              scan_count: 1,
              alert_destination_count: 1,
              monitoring_signal_count: 1,
              failing_scan_config_count: 1,
              latest_scan_job: {
                id: 'job-2',
                scan_config_id: 'scan-2',
                scan_name: 'Nightly scan',
                status: 'failed',
                started_at: '2026-05-10T08:00:00Z',
                completed_at: '2026-05-10T08:01:00Z',
                result_summary: null,
                error_message: RAW_SCAN_ERROR,
                created_at: '2026-05-10T08:01:00Z',
              },
              latest_signal: null,
            },
          },
        ]))
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })
  }

  it('formats coverage like Live activity and pluralizes counts (H2, M10, L1)', async () => {
    mockSingleProject()

    renderProjectsPage('owner')

    expect(await screen.findByText('Beta')).toBeInTheDocument()
    // H2: 320/323 renders as "99.1%", never "99%".
    expect(screen.getByText('99.1% implemented')).toBeInTheDocument()
    expect(screen.getAllByText('99.1%').length).toBeGreaterThan(0)
    expect(screen.queryByText('99% implemented')).not.toBeInTheDocument()
    // L1 + M10: singular, unit-aware copy. The rollup counts failing scan
    // CONFIGS (per-config latest run), not just the single newest job (tripl-7l83.3).
    expect(screen.getByText('1 scan config failing across 1 project')).toBeInTheDocument()
    expect(screen.getByText('across 1 project')).toBeInTheDocument()
    expect(screen.getByText('1 scan configured')).toBeInTheDocument()
    expect(screen.getByText('1 open signal')).toBeInTheDocument()
    // UX-10: the monitoring-signal metric lives once now, as an action-needed
    // stat — no separate Automation banner repeating the count.
    expect(screen.getByText('Signals')).toBeInTheDocument()
    // H1: open-signal copy drops "active" — the dashboard counts open signals.
    expect(
      screen.getByText('1 project currently has open signals'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/active or recent signals/)).not.toBeInTheDocument()
  })

  it('shows a friendly scan error with an owner-only technical expander (H3)', async () => {
    mockSingleProject()

    renderProjectsPage('owner')

    expect(await screen.findByText('Beta')).toBeInTheDocument()
    expect(
      screen.getByText('Scan failed: the data source did not respond in time.'),
    ).toBeInTheDocument()
    // Owner can drill into the raw exception behind an expander.
    expect(screen.getByText('View technical details')).toBeInTheDocument()
    expect(screen.getByText(/HTTPSConnectionPool/)).toBeInTheDocument()
  })

  it('hides raw scan internals from non-owners (H3)', async () => {
    mockSingleProject()

    renderProjectsPage('viewer')

    expect(await screen.findByText('Beta')).toBeInTheDocument()
    expect(
      screen.getByText('Scan failed: the data source did not respond in time.'),
    ).toBeInTheDocument()
    // The raw host/port exception and the expander must not exist for viewers.
    expect(screen.queryByText('View technical details')).not.toBeInTheDocument()
    expect(screen.queryByText(/HTTPSConnectionPool/)).not.toBeInTheDocument()
  })

  it('leads the project card with one attention color and calms the rest (UX-23)', async () => {
    mockSingleProject()

    renderProjectsPage('owner')

    expect(await screen.findByText('Beta')).toBeInTheDocument()
    // Live monitoring signals are the needs-attention lead → saturated danger.
    expect(screen.getByText('1 open signal')).toHaveStyle({ background: 'var(--danger-soft)' })
    // Every other supporting status chip renders calm/muted so it does not compete.
    expect(screen.getByText('99.1% implemented')).toHaveStyle({
      background: 'var(--surface-hover)',
    })
    expect(screen.getByText('1 scan configured')).toHaveStyle({
      background: 'var(--surface-hover)',
    })
    expect(screen.getByText('1 pending review')).toHaveStyle({
      background: 'var(--surface-hover)',
    })
  })

  it('surfaces the latest scan result with rows scanned (UX-18)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'proj-3',
            name: 'Gamma',
            slug: 'gamma',
            description: 'Healthy plan with a recent metrics scan.',
            created_at: '2026-06-01T09:00:00Z',
            updated_at: '2026-06-10T09:00:00Z',
            summary: {
              event_type_count: 2,
              event_count: 10,
              active_event_count: 10,
              implemented_event_count: 10,
              review_pending_event_count: 0,
              archived_event_count: 0,
              variable_count: 2,
              scan_count: 1,
              alert_destination_count: 0,
              monitoring_signal_count: 0,
              latest_scan_job: {
                id: 'job-3',
                scan_config_id: 'scan-3',
                scan_name: 'Hourly scan',
                status: 'completed',
                started_at: '2026-06-10T08:00:00Z',
                completed_at: '2026-06-10T08:02:00Z',
                result_summary: {
                  scan_rows_processed: 12345,
                  scan_truncated: false,
                },
                error_message: null,
                created_at: '2026-06-10T08:02:00Z',
              },
              latest_signal: null,
            },
          },
        ]))
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderProjectsPage('owner')

    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    expect(screen.getByText('Hourly scan')).toBeInTheDocument()
    // The Latest scan panel reports a real last result, not just a status.
    const rowsLine = screen.getByText(/rows scanned/)
    expect(rowsLine).toBeInTheDocument()
    expect(rowsLine.textContent?.replace(/[^0-9]/g, '')).toBe('12345')
  })

  it('surfaces a failing scan config even when the newest job overall succeeded (tripl-7l83.3)', async () => {
    // The project's single newest job (latest_scan_job) COMPLETED, but two other
    // scan configs fail every run. The old rollup keyed off latest_scan_job would
    // report "healthy" and hide them; failing_scan_config_count must not.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/projects')) {
        return Promise.resolve(jsonResponse([
          {
            id: 'proj-4',
            name: 'Delta',
            slug: 'delta',
            description: 'One config succeeds; two others fail every run.',
            created_at: '2026-06-01T09:00:00Z',
            updated_at: '2026-06-10T09:00:00Z',
            summary: {
              event_type_count: 2,
              event_count: 10,
              active_event_count: 10,
              implemented_event_count: 10,
              review_pending_event_count: 0,
              archived_event_count: 0,
              variable_count: 2,
              scan_count: 3,
              alert_destination_count: 0,
              monitoring_signal_count: 0,
              failing_scan_config_count: 2,
              latest_scan_job: {
                id: 'job-4',
                scan_config_id: 'scan-4',
                scan_name: 'Hourly success',
                status: 'completed',
                started_at: '2026-06-10T08:00:00Z',
                completed_at: '2026-06-10T08:02:00Z',
                result_summary: { events_created: 3 },
                error_message: null,
                created_at: '2026-06-10T08:02:00Z',
              },
              latest_signal: null,
            },
          },
        ]))
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderProjectsPage('owner')

    expect(await screen.findByText('Delta')).toBeInTheDocument()
    // Workspace rollup counts the failing configs, not "healthy".
    expect(screen.getByText('2 scan configs failing across 1 project')).toBeInTheDocument()
    expect(screen.queryByText('Latest scan jobs are healthy')).not.toBeInTheDocument()
    // The project card surfaces the failing configs even though the latest job
    // shown in its Latest scan panel succeeded.
    expect(screen.getByText('2 scan configs failing')).toBeInTheDocument()
    expect(screen.getByText('Hourly success')).toBeInTheDocument()
  })

  it('tucks project deletion behind an overflow menu, not a bare trash button (tripl-7l83.17)', async () => {
    mockSingleProject()

    renderProjectsPage('owner')

    expect(await screen.findByText('Beta')).toBeInTheDocument()
    // The one-click destructive trash button is gone from the card header.
    expect(screen.queryByRole('button', { name: /^Delete Beta$/i })).not.toBeInTheDocument()

    // Delete now lives behind an accessible overflow ("...") menu trigger.
    const trigger = screen.getByRole('button', { name: /project actions for beta/i })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')

    // The menu is keyboard-openable and the trash is reachable inside it.
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(await screen.findByRole('menuitem', { name: /delete/i })).toBeInTheDocument()
  })

  it('renders the workspace coverage fraction in a neutral tone, not danger (tripl-7l83.17)', async () => {
    mockSingleProject()

    renderProjectsPage('owner')

    expect(await screen.findByText('Beta')).toBeInTheDocument()
    const coverageStat = screen.getByText('Coverage').closest('dl')
    expect(coverageStat).not.toBeNull()
    // The Coverage MiniStat delta ("implemented/active") must read as neutral —
    // not danger/red — so a healthy 99% coverage never implies a problem.
    const fraction = within(coverageStat as HTMLElement).getByText('320/323')
    expect(fraction).toHaveStyle({ color: 'var(--fg-subtle)' })
    expect(fraction).not.toHaveStyle({ color: 'var(--danger)' })
  })

  it('links the review-queue number into the first pending project (tripl-7l83.17)', async () => {
    mockSingleProject()

    renderProjectsPage('owner')

    expect(await screen.findByText('Beta')).toBeInTheDocument()
    // The Review-queue count deep-links into the project's review triage view.
    const reviewLink = screen.getByRole('link', { name: /review queue: 1 event/i })
    expect(reviewLink).toHaveAttribute('href', '/p/beta/events/review')
  })

  it('shows an error instead of the empty state when the backend is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    renderProjectsPage()

    expect(await screen.findByText('Failed to load projects')).toBeInTheDocument()
    expect(screen.getByText('Backend is unavailable. Check that the API server is running and try again.')).toBeInTheDocument()
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
  })

  it('enters the new project after creating it instead of staying on the workspace (tripl-q7i1.8)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        const method = (init?.method ?? 'GET').toUpperCase()

        if (url.endsWith('/api/v1/projects') && method === 'POST') {
          return Promise.resolve(
            jsonResponse(
              {
                id: 'proj-new',
                name: 'My Project',
                // The server assigns a slug that DIFFERS from the client-derived
                // 'my-project' (e.g. collision handling appends a suffix), so the
                // assertion below proves navigation uses the server's returned slug
                // rather than the value the user typed (tripl-q7i1.8).
                slug: 'my-project-2',
                description: '',
                created_at: '2026-07-16T09:00:00Z',
                updated_at: '2026-07-16T09:00:00Z',
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
                  failing_scan_config_count: 0,
                  latest_scan_job: null,
                  latest_signal: null,
                },
              },
              201,
            ),
          )
        }

        if (url.endsWith('/api/v1/projects')) {
          return Promise.resolve(jsonResponse([]))
        }

        if (url.endsWith('/api/v1/data-sources')) {
          return Promise.resolve(jsonResponse([]))
        }

        return Promise.reject(new Error(`Unexpected request: ${url}`))
      },
    )

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    function LocationProbe() {
      const location = useLocation()
      return <div data-testid="location">{location.pathname}</div>
    }

    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authValue('owner')}>
          <MemoryRouter initialEntries={['/workspace']}>
            <Routes>
              <Route path="/workspace" element={<ProjectsPage />} />
              <Route path="/p/:slug/overview" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )

    // Wait for the empty workspace to settle, then open the create dialog.
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /New project/i })[0])

    // Filling the name auto-derives the slug; submit the form.
    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: 'My Project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    // On success the user is routed into the new project's overview, not left
    // stranded on /workspace.
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/p/my-project-2/overview')
    })
  })
})
