import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScansTab } from './ScansTab'

const navigateMock = vi.fn()

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}))

// CodeMirror needs real layout measurement that jsdom can't provide and
// tokenizes SQL across many spans. Stub it with a plain textarea that exposes
// the value, keeping the suite deterministic and editor content queryable.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
  }) => (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}))

vi.mock('@/hooks/useBranch', () => ({
  useActiveBranchId: () => null,
}))

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const dataSource = {
  id: 'ds-1',
  name: 'Web Production',
  db_type: 'clickhouse',
  host: 'h',
  port: 8123,
  database_name: 'analytics',
  username: 'u',
  password_set: true,
  timeout_seconds: null,
  extra_params: null,
  last_test_at: null,
  last_test_status: null,
  last_test_message: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const scanConfig = {
  id: 'scan-1',
  data_source_id: 'ds-1',
  project_id: 'p1',
  event_type_id: null,
  name: 'Main events scan',
  base_query: 'SELECT * FROM analytics.events_v2\nWHERE _ingested_at > {{since}}',
  event_type_column: 'event_category',
  time_column: 'received_at',
  event_name_format: '{action}',
  json_value_paths: ['properties.plan'],
  event_group_rules: [],
  metric_breakdown_columns: ['platform'],
  metric_breakdown_values_limit: 50,
  distribution_drift_fields: [],
  cardinality_threshold: 100,
  interval: '15m',
  replay_chunk_interval: '1d',
  scan_lookback_hours: 24,
  scan_row_limit: null,
  metrics_row_limit: null,
  app_version_column: 'app_version',
  app_version_keep_releases: 5,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function setupFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url.includes('/data-sources/') && url.includes('/schema')) {
      return mockJsonResponse({
        tables: [
          { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
        ],
      })
    }
    if (url.endsWith('/api/v1/data-sources')) return mockJsonResponse([dataSource])
    if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([scanConfig])
    if (url.includes('/scans/scan-1/jobs')) return mockJsonResponse([])
    if (url.includes('/eventTypes') || url.includes('/event-types')) return mockJsonResponse([])
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ScansTab slug="demo" />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  navigateMock.mockReset()
})

describe('ScansTab', () => {
  it('renders the scan list with KPIs and config rows', async () => {
    setupFetch()
    renderTab()

    expect(await screen.findByText('Main events scan')).toBeInTheDocument()
    // "Scan configs" appears both as a KPI label and the panel title.
    expect(screen.getAllByText('Scan configs').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Scheduled')).toBeInTheDocument()
    expect(screen.getByText('Rows scanned · 24h')).toBeInTheDocument()
    // Rows lead with a human summary (source · cadence); the raw SQL is demoted
    // to a faint secondary line rather than its own prominent column.
    expect(screen.getByText(/Web Production · Every 15 min/)).toBeInTheDocument()
    expect(screen.getByText(/SELECT \* FROM analytics\.events_v2/)).toBeInTheDocument()
  })

  it('labels failed runs as text with a sanitised message and no raw internals', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({ tables: [] })
      }
      if (url.endsWith('/api/v1/data-sources')) return mockJsonResponse([dataSource])
      if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([scanConfig])
      if (url.includes('/scans/scan-1/jobs')) {
        return mockJsonResponse([
          {
            id: 'job-fail',
            scan_config_id: 'scan-1',
            status: 'failed',
            started_at: '2026-01-01T00:00:00Z',
            completed_at: '2026-01-01T00:07:12Z',
            result_summary: null,
            error_message:
              "HTTPSConnectionPool(host='clickhouse.internal', port=8443): Read timed out. (read timeout=30)",
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:07:12Z',
          },
        ])
      }
      if (url.includes('/eventTypes') || url.includes('/event-types')) return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderTab()

    // The friendly message renders (Last-run column + Recent-runs feed); the
    // failure is labelled "Failed" as text, and no raw host/port leaks.
    expect(
      (await screen.findAllByText('Scan failed: the data source did not respond in time.')).length,
    ).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Failed').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/clickhouse\.internal/)).not.toBeInTheDocument()
  })

  it('navigates to detail by URL (not the in-place create view)', async () => {
    setupFetch()
    renderTab()

    fireEvent.click(await screen.findByText('Main events scan'))
    expect(navigateMock).toHaveBeenCalledWith('/p/demo/settings/scans/scan-1')
  })

  it('opens the create page in place and gates column mapping behind preview', async () => {
    setupFetch()
    renderTab()

    // Wait for data sources to load so the "New scan" button is enabled.
    await screen.findByText('Main events scan')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /New scan/i })).not.toBeDisabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /New scan/i }))

    // In-place page view — no router navigation occurred.
    expect(navigateMock).not.toHaveBeenCalled()
    expect(await screen.findByText('New scan config')).toBeInTheDocument()
    expect(screen.getByText('Source & query')).toBeInTheDocument()
    // Schedule is always visible; mapping cards are gated behind preview.
    expect(screen.getByText('Schedule & limits')).toBeInTheDocument()
    expect(screen.queryByText('Event mapping')).not.toBeInTheDocument()

    // Cancel returns to the list without navigation.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByText('Main events scan')).toBeInTheDocument())
    expect(screen.queryByText('New scan config')).not.toBeInTheDocument()
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
