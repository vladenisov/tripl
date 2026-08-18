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
  eventTypes?: Array<{ id: string; display_name: string }>
  events?: Array<{ id: string; name: string }>
  sources?: unknown[]
  scanConfigName?: string | null
  /** `null` models a project with no scan config at all — the bare empty series. */
  scanConfigId?: string | null
  /** `[]` models a scan whose buckets all predate the card's 7-day window. */
  volumeData?: Array<{ bucket: string; count: number; expected_count: number | null }>
  kpiSeries?: number[]
  eventNameRequests?: string[]
  topEvents?: Array<{ event_id: string; name: string; total_count: number }>
  /** Never settles the volume request, so the card stays in its pending state. */
  holdVolume?: boolean
}

function mockFetch(opts?: MockOpts) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/metrics/total')) {
      if (opts?.holdVolume) return new Promise<Response>(() => {})
      return jsonResponse({
        scope: 'project_total',
        scan_config_id: opts?.scanConfigId === undefined ? 'scan-1' : opts.scanConfigId,
        // The card charts ONE scan config and names it (tripl-jfm3.20).
        scan_config_name: opts?.scanConfigName ?? 'Snowplow Pageviews (iOS)',
        event_id: null,
        event_type_id: null,
        interval: 'hour',
        latest_signal: null,
        data: opts?.volumeData ?? [
          { bucket: 'b1', count: 10, expected_count: null },
          { bucket: 'b2', count: 25, expected_count: null },
        ],
        forecast: [],
      })
    }
    if (url.includes('/overview/kpi-series')) {
      const series = opts?.kpiSeries ?? [1, 2, 3]
      return jsonResponse({ days: series.length, new_events: series })
    }
    if (url.includes('/overview/top-events')) return jsonResponse(opts?.topEvents ?? [])
    // Metrics catalog list (issue .17): resolves metric-scope signal names.
    if (url.endsWith('/metrics') || url.includes('/metrics?')) {
      const items = opts?.catalog ?? []
      return jsonResponse({ items, total: items.length })
    }
    // Event-type / event name lookups (issue tripl-yfsj.16): resolve the
    // event-scope signal labels that dominate the expanded signal set. The
    // leading slash in the '/events' matcher is load-bearing — without it this
    // would also swallow '/overview/top-events?…' and '/event-types'.
    if (url.includes('/event-types')) return jsonResponse(opts?.eventTypes ?? [])
    // Per-signal event lookup: the panel resolves only the ids it renders
    // rather than downloading the whole catalog (tripl-jfm3.25).
    const singleEvent = /\/events\/([^/?]+)/.exec(url)
    if (singleEvent) {
      const id = singleEvent[1]!
      opts?.eventNameRequests?.push(id)
      const match = (opts?.events ?? []).find((e) => e.id === id)
      if (!match) {
        return new Response(JSON.stringify({ detail: 'Event not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return jsonResponse(match)
    }
    if (url.includes('/events?') || url.endsWith('/events')) {
      const items = opts?.events ?? []
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

  it('names the scan the volume card charts, not "project total" (tripl-jfm3.20)', async () => {
    // The card plots ONE scan. Labelled "Volume · project total" it read
    // as the project's whole volume while showing 2.4 % of it — with a "Top
    // events · 48h" row 12x larger directly beneath.
    mockFetch()
    renderOverview()

    expect(
      await screen.findByText('Volume · Snowplow Pageviews (iOS) · 7d'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Volume · project total')).not.toBeInTheDocument()
    expect(
      screen.getByText('One scan — not the project’s combined volume across all scans.'),
    ).toBeInTheDocument()
    // latest bucket count = 25
    expect(await screen.findByText('25')).toBeInTheDocument()
  })

  it('bounds the volume request to a 7-day window (tripl-jfjt)', async () => {
    // The call passed no params at all, so the endpoint summed the scan's whole
    // metric history — and the panel was still fetching 2.2s after the KPI strip,
    // Top events, Active signals and Recent activity had all rendered.
    const fetchSpy = mockFetch()
    renderOverview()

    expect(await screen.findByText('Volume · Snowplow Pageviews (iOS) · 7d')).toBeInTheDocument()

    const totalUrl = fetchSpy.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes('/metrics/total'))
    expect(totalUrl).toBeDefined()
    const params = new URL(totalUrl!, 'http://localhost').searchParams
    const from = Date.parse(params.get('from') ?? '')
    const to = Date.parse(params.get('to') ?? '')
    expect(Number.isNaN(from)).toBe(false)
    expect(Number.isNaN(to)).toBe(false)
    expect(to - from).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('reserves the volume card with a skeleton while it loads (tripl-jfjt)', async () => {
    // On all three production projects the whole rest of the page was rendered
    // while this card read a bare "Loading…" in an empty box — pending, but
    // reading as broken, and growing a subtitle line when the series landed.
    mockFetch({ holdVolume: true })
    renderOverview()

    // The rest of the page has settled...
    expect(await screen.findByText('No active monitoring signals.')).toBeInTheDocument()
    expect(await screen.findByText('No recent activity.')).toBeInTheDocument()

    // ...while the volume card holds its shape instead of a bare string.
    const volumeCard = (await screen.findByText('Volume · 7d')).closest('section')
    expect(volumeCard).not.toBeNull()
    expect(
      (volumeCard as HTMLElement).querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    // ...and never claims emptiness before the answer arrives.
    expect(screen.queryByText('No volume data yet.')).not.toBeInTheDocument()
    // The skeleton blocks are aria-hidden, so the pending state is still spoken.
    expect(screen.getByText('Loading volume…')).toBeInTheDocument()
    // The header keeps its second line rather than growing one on arrival.
    expect(
      screen.getByText('One scan — not the project’s combined volume across all scans.'),
    ).toBeInTheDocument()
  })

  it('falls back to an unnamed volume title when no scan is resolved', async () => {
    mockFetch({ scanConfigName: null })
    renderOverview()

    expect(await screen.findByText('Volume · 7d')).toBeInTheDocument()
    expect(screen.queryByText('Volume · project total')).not.toBeInTheDocument()
  })

  it('names the window on the volume card, and blames the window when it is empty', async () => {
    // The card is capped at 7 days but said so nowhere, so a scan that stopped
    // more than a week ago — the state the failing-scan chip exists to surface —
    // rendered "No volume data yet." over a project with months of buckets.
    mockFetch({ volumeData: [] })
    renderOverview()

    expect(await screen.findByText(/No volume in the last 7 days\./)).toBeInTheDocument()
    expect(screen.queryByText('No volume data yet.')).not.toBeInTheDocument()
    // The drilldown carries a range selector, so it can show what the window hides.
    expect(screen.getByRole('link', { name: /See this scan’s full history/ })).toHaveAttribute(
      'href',
      '/p/demo/monitoring/project-total/scan-1',
    )
  })

  it('still says "yet" when the project has no scan config at all', async () => {
    // The one case where nothing has ever been collected: the endpoint returns a
    // bare empty series with no scan id, so no window can be blamed.
    mockFetch({ volumeData: [], scanConfigId: null, scanConfigName: null })
    renderOverview()

    expect(await screen.findByText('No volume data yet.')).toBeInTheDocument()
    expect(screen.queryByText(/No volume in the last 7 days/)).not.toBeInTheDocument()
  })

  it('says the top-events panel spans every scan (tripl-jfm3.20)', async () => {
    // Top events sums ALL scans while the volume card above charts one, so an
    // event's 48h count can exceed the card's total. Saying so is what keeps
    // the two panels from reading as a contradiction.
    mockFetch()
    renderOverview()

    expect(
      await screen.findByText('Across every scan in this project.'),
    ).toBeInTheDocument()
  })

  it('gives top-event labels room to stay distinct (tripl-jfm3.31)', async () => {
    // The three biggest events on windy-ios share a 21-character prefix, so a
    // fixed 10rem label column truncated all three to the identical string
    // "feature_flag:flag_use…" and the ranking became unreadable.
    const topEvents = [
      { event_id: 'e1', name: 'feature_flag:flag_use:app', total_count: 26514863 },
      { event_id: 'e2', name: 'feature_flag:flag_use:growthbook', total_count: 24077526 },
      { event_id: 'e3', name: 'feature_flag:flag_use:server', total_count: 2788812 },
    ]
    mockFetch({ topEvents })
    renderOverview()

    const label = await screen.findByText('feature_flag:flag_use:growthbook')
    // The column tracks the panel width instead of being pinned at w-40, so a
    // wide panel shows the whole name.
    expect(label.className).not.toMatch(/\bw-40\b/)
    expect(label.className).toContain('w-[min(45%,22rem)]')

    // Every name still renders in full in the DOM (and in the row's a11y name),
    // so nothing depends on hovering to tell the bars apart.
    for (const e of topEvents) {
      expect(
        screen.getByRole('listitem', { name: `${e.name}: ${e.total_count.toLocaleString()} events` }),
      ).toBeInTheDocument()
    }
  })

  it('captions the KPI sparkline as new events, not active events (tripl-jfm3.22)', async () => {
    // The series is COUNT(Event) grouped by created_at. Captioned "Active trend"
    // beside "ACTIVE EVENTS 2,413" it announced days of 4,618 — more active
    // events in one day than the project has in total — and the sr-only text
    // stated that falsehood outright.
    mockFetch({ kpiSeries: [1, 2, 3, 4] })
    renderOverview()

    expect(await screen.findByText('New events · 14d')).toBeInTheDocument()
    expect(screen.queryByText('Active trend · 14d')).not.toBeInTheDocument()
    expect(screen.getByText(/New events added by day: 1, 2, 3, 4\./)).toBeInTheDocument()
    expect(screen.queryByText(/Active events by day/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: /^New events added per day over the last 14 days\./ }),
    ).toBeInTheDocument()
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

  it('labels event- and event-type-scope signals with their names, not a raw UUID (tripl-yfsj.16)', async () => {
    mockFetch({
      events: [{ id: 'd78ddc27-4b1e-4a0c-9f77-2c9f0f2a51bd', name: 'map:open:spot' }],
      eventTypes: [{ id: '5f2b91aa-0d13-4c7e-9a26-1d8e3b7f42c1', display_name: 'Map' }],
      signals: [
        {
          scan_config_id: 'scan-1',
          scope_type: 'event',
          scope_ref: 'd78ddc27-4b1e-4a0c-9f77-2c9f0f2a51bd',
          state: 'latest_scan',
          event_id: 'd78ddc27-4b1e-4a0c-9f77-2c9f0f2a51bd',
          event_type_id: null,
          bucket: '2026-07-01T00:00:00Z',
          actual_count: 300,
          expected_count: 100,
          stddev: 12,
          z_score: 8,
          direction: 'spike',
        },
        {
          scan_config_id: 'scan-1',
          scope_type: 'event_type',
          scope_ref: '5f2b91aa-0d13-4c7e-9a26-1d8e3b7f42c1',
          state: 'latest_scan',
          event_id: null,
          event_type_id: '5f2b91aa-0d13-4c7e-9a26-1d8e3b7f42c1',
          bucket: '2026-07-01T00:00:00Z',
          actual_count: 20,
          expected_count: 100,
          stddev: 9,
          z_score: -7,
          direction: 'drop',
        },
      ],
    })
    renderOverview()

    // The bug: Overview rendered "Spike on Event d78ddc27" while the Anomalies
    // page showed the real name for the very same signal.
    expect(await screen.findByText('Spike on Event · map:open:spot')).toBeInTheDocument()
    expect(screen.queryByText(/Event d78ddc27/)).not.toBeInTheDocument()
    expect(await screen.findByText('Drop on Event type · Map')).toBeInTheDocument()
    expect(screen.queryByText(/Event type 5f2b91aa/)).not.toBeInTheDocument()
  })

  it('resolves signal event names one by one, never by listing the catalog (tripl-jfm3.25)', async () => {
    // The panel used to fire GET /events?limit=10000 — 2,413 rows / 2.7 MB / ~3 s
    // of tags, field values and meta values — purely to label six rows, leaving
    // raw uuid stubs on the default landing route until it landed.
    const eventNameRequests: string[] = []
    const fetchSpy = mockFetch({
      eventNameRequests,
      events: [{ id: 'd78ddc27-4b1e-4a0c-9f77-2c9f0f2a51bd', name: 'map:open:spot' }],
      signals: [
        makeEventSignal('d78ddc27-4b1e-4a0c-9f77-2c9f0f2a51bd'),
      ],
    })
    renderOverview()

    expect(await screen.findByText('Spike on Event · map:open:spot')).toBeInTheDocument()
    expect(eventNameRequests).toEqual(['d78ddc27-4b1e-4a0c-9f77-2c9f0f2a51bd'])
    const listCalls = fetchSpy.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('limit=10000'))
    expect(listCalls).toEqual([])
  })

  it('still renders the signals panel when a name lookup resolves nothing (tripl-yfsj.16)', async () => {
    // Name maps are additive: an empty/unresolvable lookup — the same state the
    // panel is in before the lists land — must degrade to the short-ref label
    // rather than blanking or blocking the row.
    mockFetch({
      events: [],
      signals: [
        {
          scan_config_id: 'scan-1',
          scope_type: 'event',
          scope_ref: 'd78ddc27-4b1e-4a0c-9f77-2c9f0f2a51bd',
          state: 'latest_scan',
          event_id: 'd78ddc27-4b1e-4a0c-9f77-2c9f0f2a51bd',
          event_type_id: null,
          bucket: '2026-07-01T00:00:00Z',
          actual_count: 300,
          expected_count: 100,
          stddev: 12,
          z_score: 8,
          direction: 'spike',
        },
      ],
    })
    renderOverview()

    expect(await screen.findByText('Spike on Event d78ddc27')).toBeInTheDocument()
  })

  it('labels a drop-to-zero signal as "dropped to zero", not the clamped z-score (tripl-yfsj.9)', async () => {
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
          actual_count: 0,
          expected_count: 80,
          stddev: 5,
          z_score: -20,
          direction: 'drop',
        },
      ],
    })
    renderOverview()

    const row = (await screen.findByText('Drop on Metric · Checkout conversion')).closest('a')
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('dropped to zero')
    // The repeated, clamped "z=-20.0" must not be surfaced for zeroed drops.
    expect(row).not.toHaveTextContent('z=-20')
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

function makeEventSignal(scopeRef: string) {
  return {
    scan_config_id: 'scan-1',
    scope_type: 'event',
    scope_ref: scopeRef,
    state: 'latest_scan',
    event_id: scopeRef,
    event_type_id: null,
    bucket: '2026-07-01T00:00:00Z',
    actual_count: 300,
    expected_count: 100,
    stddev: 12,
    z_score: 8,
    direction: 'spike',
  }
}

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
