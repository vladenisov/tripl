import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import OverviewPage from './OverviewPage'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const PROJECT = {
  id: 'project-1',
  name: 'Demo',
  slug: 'demo',
  description: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  summary: {
    event_type_count: 6,
    event_count: 2483,
    active_event_count: 323,
    implemented_event_count: 320,
    review_pending_event_count: 8,
    archived_event_count: 12,
    variable_count: 40,
    scan_count: 5,
    // Superset, event-scope-inclusive count. The Overview must NOT use this for
    // "Open signals" — it has to follow the (empty) signals array instead (H1).
    monitoring_signal_count: 5,
    latest_scan_job: null,
    latest_signal: null,
  },
}

interface MockOpts {
  activity?: unknown[]
  signals?: unknown[]
  catalog?: Array<{ id: string; display_name: string }>
  sources?: unknown[]
}

function mockFetch(opts?: MockOpts) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/metrics/total')) {
      return jsonResponse({
        scope: 'project_total',
        scan_config_id: null,
        event_id: null,
        event_type_id: null,
        interval: 'hour',
        latest_signal: null,
        data: [
          { bucket: 'b1', count: 10, expected_count: null },
          { bucket: 'b2', count: 25, expected_count: null },
        ],
        forecast: [],
      })
    }
    // Metrics catalog list (issue .17): resolves metric-scope signal names.
    if (url.endsWith('/metrics') || url.includes('/metrics?')) {
      const items = opts?.catalog ?? []
      return jsonResponse({ items, total: items.length })
    }
    if (url.includes('/anomalies/signals')) return jsonResponse(opts?.signals ?? [])
    if (url.includes('/activity/projects/')) return jsonResponse(opts?.activity ?? [])
    if (url.includes('/data-sources')) return jsonResponse(opts?.sources ?? [])
    if (url.endsWith('/projects/demo')) return jsonResponse(PROJECT)
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

// OverviewPage renders OnboardingChecklist, which reads the current user via
// useAuth(); provide an AuthContext so that hook doesn't throw. An owner user
// keeps the checklist's owner-only steps in their normal (non-gated) state.
const AUTH_VALUE: AuthContextValue = {
  user: {
    id: 'user-1',
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

function renderOverview(path = '/p/demo/overview') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={AUTH_VALUE}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/p/:slug/overview" element={<OverviewPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OverviewPage', () => {
  it('renders the KPI strip with active events and plan coverage', async () => {
    mockFetch()
    renderOverview()

    expect(await screen.findByRole('heading', { name: 'Live activity' })).toBeInTheDocument()
    expect(screen.getByText('Active events')).toBeInTheDocument()

    // active_event_count = 323 → "323"
    expect(await screen.findByText('323')).toBeInTheDocument()
    // plan coverage 320/323 → "99.1%", identical to the projects dashboard (issue H2)
    expect(await screen.findByText('99.1%')).toBeInTheDocument()
    expect(screen.getByText('Coverage')).toBeInTheDocument()
  })

  it('shows the project-total volume trend once metrics load', async () => {
    mockFetch()
    renderOverview()

    expect(await screen.findByText('Volume · project total')).toBeInTheDocument()
    // latest bucket count = 25
    expect(await screen.findByText('25')).toBeInTheDocument()
  })

  it('keeps the open-signals headline in agreement with the signals panel (issue H1)', async () => {
    // monitoring_signal_count is 5, but the canonical signals array is empty.
    mockFetch()
    renderOverview()

    expect(await screen.findByText('Open signals')).toBeInTheDocument()
    // The panel renders no rows...
    expect(await screen.findByText('No active monitoring signals.')).toBeInTheDocument()
    // ...so the headline must read 0 — never the superset monitoring_signal_count (5).
    // Widgets now wait for the project query to confirm the slug exists (the .9
    // 404 short-circuit), so the signals stat resolves a tick after the panel —
    // await it rather than reading synchronously.
    expect(await screen.findByText('0')).toBeInTheDocument()
    expect(screen.queryByText('5')).not.toBeInTheDocument()
  })

  it('renders a friendly message for failed-scan activity, hiding raw internals (issue H3)', async () => {
    const rawError =
      "HTTPSConnectionPool(host='clickhouse.internal', port=8443): Read timed out. (read timeout=30)"
    mockFetch({
      activity: [
        {
          id: 'a1',
          project_id: 'project-1',
          project_slug: 'demo',
          project_name: 'Demo',
          type: 'scan',
          severity: 'high',
          title: 'Scan failed: Nightly metrics',
          detail: rawError,
          occurred_at: '2026-06-25T10:00:00Z',
          target_path: null,
        },
      ],
    })
    renderOverview()

    expect(
      await screen.findByText('Scan failed: the data source did not respond in time.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/HTTPSConnectionPool/)).not.toBeInTheDocument()
    expect(screen.queryByText(/clickhouse\.internal/)).not.toBeInTheDocument()
    // The activity title carries its full text as a native tooltip so a long
    // event reference stays readable when the row ellipsizes (tripl-7l83.15).
    expect(screen.getByText('Scan failed: Nightly metrics')).toHaveAttribute(
      'title',
      'Scan failed: Nightly metrics',
    )
  })

  it('short-circuits to the full-page not-found on a project 404 (issue .9)', async () => {
    // A nonexistent slug 404s the project query; the whole widget grid is
    // replaced by NotFoundPage and the project-scoped widgets never fire.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/data-sources')) return jsonResponse([])
      if (url.includes('/projects/does-not-exist')) {
        return new Response(JSON.stringify({ detail: 'Project not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderOverview('/p/does-not-exist/overview')

    expect(await screen.findByText('Page not found')).toBeInTheDocument()
    // The KPI strip / widgets must not render alongside the not-found page.
    expect(screen.queryByRole('heading', { name: 'Live activity' })).not.toBeInTheDocument()
  })

  it('labels a metric-scope signal with its catalog display name (issue .17)', async () => {
    mockFetch({
      catalog: [{ id: 'metric-abc', display_name: 'Checkout conversion' }],
      signals: [
        {
          scan_config_id: 'scan-1',
          scope_type: 'metric',
          scope_ref: 'metric-abc',
          state: 'latest_scan',
          event_id: null,
          event_type_id: null,
          bucket: '2026-07-01T00:00:00Z',
          actual_count: 40,
          expected_count: 100,
          stddev: 5,
          z_score: -6,
          direction: 'drop',
        },
      ],
    })
    renderOverview()

    // Resolves via the catalog map to "Metric · <display name>" — never the raw
    // "Event <uuid8>" fallback the old copy produced.
    expect(await screen.findByText('Drop on Metric · Checkout conversion')).toBeInTheDocument()
    expect(screen.queryByText(/Event metric-a/)).not.toBeInTheDocument()
  })

  it('scopes the source-health rail to this project plus global sources (issue .14)', async () => {
    mockFetch({
      sources: [
        makeSource({ id: 's-global', name: 'Shared warehouse', project_id: null }),
        makeSource({ id: 's-mine', name: 'Demo synthetic', project_id: 'project-1' }),
        makeSource({ id: 's-other', name: 'Other project source', project_id: 'project-2' }),
      ],
    })
    renderOverview()

    expect(await screen.findByText('Shared warehouse')).toBeInTheDocument()
    expect(screen.getByText('Demo synthetic')).toBeInTheDocument()
    // A source owned by a different project must not leak into this rail.
    expect(screen.queryByText('Other project source')).not.toBeInTheDocument()
  })
})

function makeSource(overrides: {
  id: string
  name: string
  project_id: string | null
}) {
  return {
    db_type: 'clickhouse',
    is_synthetic: false,
    host: 'h',
    port: 8123,
    database_name: 'db',
    username: 'u',
    password_set: false,
    timeout_seconds: null,
    json_path_discovery: null,
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
    last_test_at: '2026-07-01T00:00:00Z',
    last_test_status: 'success',
    last_test_message: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}
