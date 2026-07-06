import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@/components/theme-provider'
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

function mockFetch(opts?: { activity?: unknown[] }) {
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
    if (url.includes('/anomalies/signals')) return jsonResponse([])
    if (url.includes('/activity/projects/')) return jsonResponse(opts?.activity ?? [])
    if (url.includes('/data-sources')) return jsonResponse([])
    if (url.endsWith('/projects/demo')) return jsonResponse(PROJECT)
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderOverview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/p/demo/overview']}>
          <Routes>
            <Route path="/p/:slug/overview" element={<OverviewPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
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
    expect(screen.getByText('0')).toBeInTheDocument()
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
})
