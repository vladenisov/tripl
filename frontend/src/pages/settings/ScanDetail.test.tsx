import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScanConfig } from '@/types'
import { ScanDetail } from './ScanDetail'

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const scanConfig: ScanConfig = {
  id: 'scan-1',
  data_source_id: 'ds-1',
  project_id: 'project-1',
  event_type_id: null,
  name: 'Main scan',
  base_query: 'SELECT * FROM analytics.events',
  event_type_column: null,
  time_column: 'created_at',
  event_name_format: null,
  json_value_paths: [],
  event_group_rules: [],
  metric_breakdown_columns: [],
  metric_breakdown_values_limit: null,
  distribution_drift_fields: [],
  cardinality_threshold: 100,
  interval: '1h',
  replay_chunk_interval: '1h',
  scan_lookback_hours: null,
  scan_row_limit: null,
  metrics_row_limit: null,
  app_version_column: null,
  app_version_keep_releases: null,
  platform_column: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScanDetail', () => {
  it('shows replay chunk progress for running jobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/platform-presence')) {
        return mockJsonResponse({ scan_config_id: 'scan-1', platform_column: null, platforms: [], items: [] })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([
          {
            id: 'job-1',
            scan_config_id: 'scan-1',
            status: 'running',
            started_at: '2026-01-01T00:00:00Z',
            completed_at: null,
            result_summary: {
              mode: 'metrics_replay',
              catalog_sync_skipped: true,
              time_from: '2026-01-01T00:00:00Z',
              time_to: '2026-01-01T04:00:00Z',
              replay_chunk_interval: '1h',
              replay_chunks_total: 4,
              replay_chunks_completed: 2,
              replay_current_chunk_index: 3,
              replay_current_chunk_from: '2026-01-01T02:00:00Z',
              replay_current_chunk_to: '2026-01-01T03:00:00Z',
              replay_progress_percent: 50,
              replay_progress_phase: 'collecting',
            },
            error_message: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:20:00Z',
          },
        ])
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ScanDetail slug="demo" scanConfig={scanConfig} eventTypes={[]} branchId={null} />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('2/4 chunks')).toBeInTheDocument()
    expect(screen.getByText('processing 3/4')).toBeInTheDocument()
    expect(screen.getAllByRole('progressbar', { name: 'Replay chunks' })[0]).toHaveAttribute(
      'aria-valuenow',
      '50',
    )
  })

  it('renders the overview panels with real ScanConfig fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/platform-presence')) {
        return mockJsonResponse({ scan_config_id: 'scan-1', platform_column: null, platforms: [], items: [] })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ScanDetail slug="demo" scanConfig={scanConfig} eventTypes={[]} branchId={null} />
      </QueryClientProvider>,
    )

    // Overview stat cards + panels use the real fields.
    expect(await screen.findByText('Source & query')).toBeInTheDocument()
    expect(screen.getByText('Event mapping')).toBeInTheDocument()
    expect(screen.getByText('Metrics & drift')).toBeInTheDocument()
    expect(screen.getByText('Last run')).toBeInTheDocument()
    expect(screen.getByText('SELECT * FROM analytics.events')).toBeInTheDocument()
    // The mocked config has time_column set and no event type → Auto-detect.
    expect(screen.getByText('created_at')).toBeInTheDocument()
    expect(screen.getByText('Auto-detect')).toBeInTheDocument()
    expect(await screen.findByText(/No jobs yet/)).toBeInTheDocument()
  })

  it('labels a failed job, offers a retry, and never shows raw scan internals', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/platform-presence')) {
        return mockJsonResponse({ scan_config_id: 'scan-1', platform_column: null, platforms: [], items: [] })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([
          {
            id: 'job-fail',
            scan_config_id: 'scan-1',
            status: 'failed',
            // 381.8s elapsed — a silent timeout under the old red-dot UI.
            started_at: '2026-01-01T00:00:00Z',
            completed_at: '2026-01-01T00:06:21Z',
            result_summary: null,
            error_message:
              "HTTPSConnectionPool(host='clickhouse.internal', port=8443): Read timed out. (read timeout=30)",
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:06:21Z',
          },
        ])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ScanDetail slug="demo" scanConfig={scanConfig} eventTypes={[]} branchId={null} />
      </QueryClientProvider>,
    )

    // Status is readable as text (not a bare red dot) and a retry is wired.
    expect(await screen.findByText('Failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry scan' })).toBeInTheDocument()
    // Raw host/port never reaches the DOM, collapsed or expanded.
    expect(screen.queryByText(/clickhouse\.internal/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand job details' }))
    expect(
      screen.getByText('Scan failed: the data source did not respond in time.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/clickhouse\.internal/)).not.toBeInTheDocument()
    expect(screen.queryByText(/8443/)).not.toBeInTheDocument()
  })

  it('renders the platform presence grid from a mocked response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/platform-presence')) {
        return mockJsonResponse({
          scan_config_id: 'scan-1',
          platform_column: 'platform',
          platforms: ['android', 'ios'],
          items: [
            { event_id: 'evt-checkout', event_name: 'checkout', present_platforms: ['android', 'ios'] },
            { event_id: 'evt-signup', event_name: 'signup', present_platforms: ['ios'] },
          ],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ScanDetail slug="demo" scanConfig={scanConfig} eventTypes={[]} branchId={null} />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Platform presence')).toBeInTheDocument()
    // Column headers are the sorted distinct platform values (await the async grid load).
    expect(await screen.findByRole('columnheader', { name: 'android' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'ios' })).toBeInTheDocument()
    // Rows are events; cells encode presence as ✓ / — with accessible labels.
    expect(screen.getByText('checkout')).toBeInTheDocument()
    expect(screen.getByText('signup')).toBeInTheDocument()
    expect(screen.getByLabelText('checkout present on android')).toHaveTextContent('✓')
    expect(screen.getByLabelText('signup absent on android')).toHaveTextContent('—')
    expect(screen.getByLabelText('signup present on ios')).toHaveTextContent('✓')
  })

  it('shows an empty state when no platform column is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/platform-presence')) {
        return mockJsonResponse({
          scan_config_id: 'scan-1',
          platform_column: null,
          platforms: [],
          items: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <ScanDetail slug="demo" scanConfig={scanConfig} eventTypes={[]} branchId={null} />
      </QueryClientProvider>,
    )

    expect(await screen.findByText('No platform column configured')).toBeInTheDocument()
  })
})
