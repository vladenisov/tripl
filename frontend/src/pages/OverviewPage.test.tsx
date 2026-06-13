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
    active_event_count: 2483,
    implemented_event_count: 100,
    review_pending_event_count: 8,
    archived_event_count: 12,
    variable_count: 40,
    scan_count: 5,
    alert_destination_count: 2,
    monitoring_signal_count: 0,
    latest_scan_job: null,
    latest_signal: null,
  },
}

function mockFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/reconciliation/coverage')) {
      return jsonResponse({
        items: [],
        summary: { total_count: 100, matched_count: 92, coverage_pct: 92 },
        days: 14,
      })
    }
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
    if (url.includes('/activity/projects/')) return jsonResponse([])
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
  it('renders the KPI strip from project summary and reconciliation coverage', async () => {
    mockFetch()
    renderOverview()

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByText('Active events')).toBeInTheDocument()

    // active_event_count = 2483 → "2,483"; coverage 92 → "92.0%"
    expect(await screen.findByText('2,483')).toBeInTheDocument()
    expect(await screen.findByText('92.0%')).toBeInTheDocument()
    expect(screen.getByText('Coverage')).toBeInTheDocument()
  })

  it('shows the project-total volume trend once metrics load', async () => {
    mockFetch()
    renderOverview()

    expect(await screen.findByText('Volume · project total')).toBeInTheDocument()
    // latest bucket count = 25
    expect(await screen.findByText('25')).toBeInTheDocument()
  })
})
