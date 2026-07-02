import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventMetricPoint } from '@/types'
import MonitoringDetailPage from './MonitoringDetailPage'

vi.mock('@/components/ui/chart-lazy', () => ({
  MetricsChart: ({
    data,
    forecast,
  }: {
    data?: Array<{ bucket: string }>
    forecast?: unknown[]
  }) => (
    <div
      data-testid="metrics-chart"
      data-forecast-count={forecast?.length ?? 0}
      data-points={data?.length ?? 0}
      data-first-bucket={data?.[0]?.bucket ?? ''}
    />
  ),
  MetricsMultiSeriesChart: ({
    series,
    emptyLabel,
  }: {
    series: Array<{ label: string }>
    emptyLabel?: string
  }) => (
    <div data-testid="multi-chart" data-labels={series.map(item => item.label).join('|')}>
      {series.length ? series.map(item => <span key={item.label}>{item.label}</span>) : emptyLabel}
    </div>
  ),
}))

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function metricPoint(bucket: string, count: number): EventMetricPoint {
  return {
    bucket,
    count,
    expected_count: null,
    stddev: null,
    is_anomaly: false,
    anomaly_direction: null,
    z_score: null,
  }
}

function appVersionResponse(scanConfigId: string) {
  return {
    scan_config_id: scanConfigId,
    scope_type: 'project_total',
    scope_ref: scanConfigId,
    event_id: null,
    event_type_id: null,
    app_version_column: 'app_version',
    interval: '1h',
    latest_version: '2.10.0',
    versions: [
      { version: '2.10.0', is_other: false, is_latest: true },
      { version: '2.9.0', is_other: false, is_latest: false },
      { version: 'Other', is_other: true, is_latest: false },
    ],
    series: [
      {
        version: '2.10.0',
        is_other: false,
        is_latest: true,
        total_count: 120,
        data: [metricPoint('2026-01-02T00:00:00Z', 120)],
      },
      {
        version: '2.9.0',
        is_other: false,
        is_latest: false,
        total_count: 80,
        data: [metricPoint('2026-01-02T00:00:00Z', 80)],
      },
      {
        version: 'Other',
        is_other: true,
        is_latest: false,
        total_count: 10,
        data: [metricPoint('2026-01-02T00:00:00Z', 10)],
      },
    ],
  }
}

function appVersionAdoptionResponse(scanConfigId: string) {
  return {
    ...appVersionResponse(scanConfigId),
    totals: [{ bucket: '2026-01-02T00:00:00Z', count: 210 }],
  }
}

function renderMonitoringPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/monitoring/project-total/scan-1']}>
        <Routes>
          <Route path="/p/:slug/monitoring/:scope/:id" element={<MonitoringDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MonitoringDetailPage app-version view', () => {
  it('renders semver-ordered version charts and filters to latest', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/metrics/total')) {
        return mockJsonResponse({
          scope: 'project_total',
          scan_config_id: 'scan-1',
          event_id: null,
          event_type_id: null,
          interval: '1h',
          latest_signal: null,
          data: [metricPoint('2026-01-02T00:00:00Z', 210)],
          forecast: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1')) {
        return mockJsonResponse({ id: 'scan-1', app_version_column: 'app_version' })
      }
      if (url.includes('/api/v1/projects/demo/annotations')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/scans/scan-1/app-versions')) {
        return mockJsonResponse(appVersionResponse('scan-1'))
      }
      if (url.includes('/api/v1/projects/demo/scans/scan-1/version-adoption')) {
        return mockJsonResponse(appVersionAdoptionResponse('scan-1'))
      }
      if (url.includes('/api/v1/projects/demo/scans/scan-1/release-regressions')) {
        return mockJsonResponse({
          scan_config_id: 'scan-1',
          app_version_column: 'app_version',
          latest_version: '2.10.0',
          items: [],
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderMonitoringPage()

    const byVersionTab = await screen.findByRole('tab', { name: /By version/i })
    fireEvent.pointerDown(byVersionTab, { button: 0, ctrlKey: false })
    fireEvent.mouseDown(byVersionTab, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(byVersionTab, { button: 0, ctrlKey: false })
    fireEvent.mouseUp(byVersionTab, { button: 0, ctrlKey: false })
    fireEvent.click(byVersionTab)

    expect(await screen.findByText('latest 2.10.0')).toBeInTheDocument()
    await waitFor(() => {
      const charts = screen.getAllByTestId('multi-chart')
      expect(charts[0]).toHaveAttribute('data-labels', '2.10.0 · latest|2.9.0|Other')
      expect(charts[1]).toHaveAttribute('data-labels', '2.10.0 · latest|2.9.0|Other')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Latest' }))

    await waitFor(() => {
      const charts = screen.getAllByTestId('multi-chart')
      expect(charts[0]).toHaveAttribute('data-labels', '2.10.0 · latest')
      expect(charts[1]).toHaveAttribute('data-labels', '2.10.0 · latest')
    })
  })

  it('hides the tab when the scan has no app version column', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      calls.push(url)

      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/metrics/total')) {
        return mockJsonResponse({
          scope: 'project_total',
          scan_config_id: 'scan-1',
          event_id: null,
          event_type_id: null,
          interval: '1h',
          latest_signal: null,
          data: [metricPoint('2026-01-02T00:00:00Z', 210)],
          forecast: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1')) {
        return mockJsonResponse({ id: 'scan-1', app_version_column: null })
      }
      if (url.includes('/api/v1/projects/demo/annotations')) return mockJsonResponse([])

      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderMonitoringPage()

    await waitFor(() => {
      expect(calls.some(url => url.endsWith('/api/v1/projects/demo/scans/scan-1'))).toBe(true)
    })
    expect(screen.queryByRole('tab', { name: /By version/i })).not.toBeInTheDocument()
    expect(calls.some(url => url.includes('/app-versions'))).toBe(false)
    expect(calls.some(url => url.includes('/version-adoption'))).toBe(false)
  })
})

function eventTypeFixture() {
  return {
    id: 'type-1',
    project_id: 'project-1',
    name: 'page',
    display_name: 'Page',
    description: '',
    color: '#0ea5e9',
    order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    field_definitions: [
      {
        id: 'field-country',
        event_type_id: 'type-1',
        name: 'country',
        display_name: 'Country',
        field_type: 'string',
        is_required: true,
        enum_options: null,
        description: '',
        order: 0,
        sensitivity: 'pii',
      },
    ],
  }
}

function eventFixture() {
  return {
    id: 'event-1',
    project_id: 'project-1',
    event_type_id: 'type-1',
    event_type: { id: 'type-1', name: 'page', display_name: 'Page', color: '#0ea5e9' },
    name: 'checkout_completed',
    description: 'Fired on checkout.',
    order: 0,
    status: 'live',
    sunset_at: null,
    last_seen_at: '2026-01-02T00:00:00Z',
    metric_breakdown_columns: ['platform'],
    drift_count: 2,
    tags: [{ id: 'tag-1', name: 'revenue' }],
    field_values: [
      { id: 'fv-1', field_definition_id: 'field-country', value: 'US', variable_values: [] },
    ],
    meta_values: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  }
}

function renderEventDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/monitoring/event/event-1']}>
        <Routes>
          <Route path="/p/:slug/monitoring/:scope/:id" element={<MonitoringDetailPage />} />
          <Route path="/p/:slug/events/:tab/:eventId/edit" element={<div>edit-page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('MonitoringDetailPage event detail', () => {
  it('renders the event-aware detail with signal banner and routes Edit to the edit page', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([eventTypeFixture()])
      }
      if (url.endsWith('/api/v1/projects/demo/meta-fields')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/variables')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events/event-1/history')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events/event-1/metrics')) {
        return mockJsonResponse({
          scope: 'event',
          scan_config_id: 'scan-1',
          event_id: 'event-1',
          event_type_id: 'type-1',
          interval: '1h',
          latest_signal: {
            scan_config_id: 'scan-1',
            scope_type: 'event',
            scope_ref: 'event-1',
            state: 'recent',
            event_id: 'event-1',
            event_type_id: null,
            bucket: '2026-01-02T00:00:00Z',
            actual_count: 200,
            expected_count: 100,
            stddev: 10,
            z_score: 4.2,
            direction: 'spike',
          },
          data: [metricPoint('2026-01-02T00:00:00Z', 200)],
          forecast: [],
        })
      }
      if (url.includes('/api/v1/projects/demo/events/event-1/photos')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events/event-1')) return mockJsonResponse(eventFixture())
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1')) {
        return mockJsonResponse({ id: 'scan-1', app_version_column: null })
      }
      if (url.includes('/api/v1/projects/demo/annotations')) return mockJsonResponse([])

      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderEventDetail()

    expect(await screen.findByRole('heading', { name: 'checkout_completed' })).toBeInTheDocument()
    // Signal banner derived from latest_signal (spike, +100% vs baseline).
    expect(screen.getByText(/Volume spike detected/)).toBeInTheDocument()
    // Fields table shows the schema field with its sensitivity chip.
    expect(screen.getByText('country')).toBeInTheDocument()
    expect(screen.getByText('PII')).toBeInTheDocument()
    // Real breakdown column from the event surfaces in the side column.
    expect(screen.getByText('platform')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    expect(await screen.findByText('edit-page')).toBeInTheDocument()
  })
})

function installEventDetailFetch(
  opts: { metricsData?: EventMetricPoint[]; event?: Record<string, unknown> } = {},
) {
  const metricsData = opts.metricsData ?? [metricPoint('2026-01-02T00:00:00Z', 200)]
  const event = opts.event ?? eventFixture()
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url.endsWith('/api/v1/projects/demo/event-types')) {
      return mockJsonResponse([eventTypeFixture()])
    }
    if (url.endsWith('/api/v1/projects/demo/meta-fields')) return mockJsonResponse([])
    if (url.endsWith('/api/v1/projects/demo/variables')) return mockJsonResponse([])
    if (url.includes('/api/v1/projects/demo/events/event-1/history')) return mockJsonResponse([])
    if (url.includes('/api/v1/projects/demo/events/event-1/metrics')) {
      return mockJsonResponse({
        scope: 'event',
        scan_config_id: 'scan-1',
        event_id: 'event-1',
        event_type_id: 'type-1',
        interval: '1h',
        latest_signal: null,
        data: metricsData,
        forecast: [],
      })
    }
    if (url.includes('/api/v1/projects/demo/events/event-1/photos')) return mockJsonResponse([])
    if (url.endsWith('/api/v1/projects/demo/events/event-1')) return mockJsonResponse(event)
    if (url.endsWith('/api/v1/projects/demo/scans/scan-1')) {
      return mockJsonResponse({ id: 'scan-1', app_version_column: null })
    }
    if (url.includes('/api/v1/projects/demo/annotations')) return mockJsonResponse([])

    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderLegacyEventDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/events/detail/event-1']}>
        <Routes>
          {/* Legacy scope-less shape mounted directly to exercise the defensive
              scope default; in the app this URL redirects to the canonical route. */}
          <Route path="/p/:slug/events/detail/:eventId" element={<MonitoringDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('MonitoringDetailPage event-detail header and semantics', () => {
  it('renders without crashing when mounted from the legacy scope-less route', async () => {
    installEventDetailFetch()
    renderLegacyEventDetail()

    // B1: resolveDetailScope defaults to the event scope when only an eventId is
    // present, so the page renders the event hero instead of throwing.
    expect(await screen.findByRole('heading', { name: 'checkout_completed' })).toBeInTheDocument()
  })

  it('keeps only live actions in the primary row and tucks coming-soon ones into an overflow menu', async () => {
    installEventDetailFetch()
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    // Live actions stay in the primary row, enabled.
    expect(screen.getByRole('button', { name: 'Metrics' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()

    // Coming-soon actions no longer sit in the primary row as inert disabled buttons.
    expect(screen.queryByRole('button', { name: 'Watch' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Implementation' })).not.toBeInTheDocument()

    // They live behind an overflow ("…") menu instead.
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument()
  })

  it('shows a Plan / Events / <name> breadcrumb for the event scope', async () => {
    installEventDetailFetch()
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(breadcrumb).getByRole('button', { name: 'Plan' })).toBeInTheDocument()
    expect(within(breadcrumb).getByRole('button', { name: 'Events' })).toBeInTheDocument()
    expect(within(breadcrumb).getByText('checkout_completed')).toBeInTheDocument()
  })

  it('explains the empty 24h metrics instead of rendering a bare dash', async () => {
    installEventDetailFetch({ metricsData: [] })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    expect(screen.getByText('Volume · 24h').closest('[title]')).toHaveAttribute(
      'title',
      'No events in the last 24h',
    )
    expect(screen.getByText('Δ · 24h').closest('[title]')).toHaveAttribute(
      'title',
      'No prior 24h window to compare against',
    )
  })

  it('de-emphasises and explains empty drift and last-seen stats', async () => {
    // Visual de-emphasis (var(--fg-faint)) is verified by inspection; the testable
    // contract is the hover hint that explains the empty "0" / "—" values.
    installEventDetailFetch({
      event: { ...eventFixture(), drift_count: 0, last_seen_at: null },
    })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    expect(screen.getByText('Schema drifts').closest('[title]')).toHaveAttribute(
      'title',
      'No schema drifts detected',
    )
    // "Last seen" also labels a Properties row, so pick the stat card (the only
    // "Last seen" wrapped in a title-bearing element).
    const lastSeenStat = screen
      .getAllByText('Last seen')
      .map(node => node.closest('[title]'))
      .find(Boolean)
    expect(lastSeenStat).toHaveAttribute('title', 'No hits recorded yet')
  })

  it('coaches empty volume metrics and empty change history instead of blank panels', async () => {
    // No metric points and (per installEventDetailFetch) no history entries, so
    // both lower panels should render their coached empty states.
    installEventDetailFetch({ metricsData: [] })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    expect(screen.getByText('No metrics data available')).toBeInTheDocument()
    expect(
      screen.getByText('Run a scan to start collecting volume metrics for this scope.'),
    ).toBeInTheDocument()

    expect(screen.getByText('No recent changes')).toBeInTheDocument()
    expect(
      screen.getByText("Edits to this event's definition will show up here."),
    ).toBeInTheDocument()
  })

  it('exposes table semantics for the Fields and Properties tables', async () => {
    installEventDetailFetch()
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    expect(screen.getByRole('table', { name: 'Fields' })).toBeInTheDocument()

    const properties = screen.getByRole('table', { name: 'Properties' })
    expect(properties).toBeInTheDocument()
    expect(within(properties).getAllByRole('row').length).toBeGreaterThan(0)
    expect(within(properties).getAllByRole('rowheader')[0]).toHaveTextContent('Event type')
  })
})

describe('MonitoringDetailPage catalog-metric drilldown', () => {
  function metricSeriesPoint(bucket: string, value: number) {
    return {
      bucket,
      value,
      expected_count: null,
      stddev: null,
      is_anomaly: false,
      anomaly_direction: null,
      z_score: null,
    }
  }

  function metricDefinitionResponse(interval: string | null) {
    return {
      id: 'metric-1',
      project_id: 'p-1',
      name: 'dau',
      display_name: 'Daily Active Users',
      description: '',
      color: '#8884d8',
      order: 0,
      unit: null,
      status: 'active',
      owner_id: null,
      reviewed: false,
      kind: 'sql',
      aggregation: null,
      composition: null,
      config: {},
      breakdown_columns: [],
      breakdown_values_limit: null,
      app_version_column: null,
      platform_column: null,
      data_source_id: null,
      interval,
      replay_chunk_interval: null,
      numerator_event_id: null,
      numerator_event_type_id: null,
      denominator_event_id: null,
      denominator_event_type_id: null,
      anomaly_detection_enabled: true,
      last_collected_at: null,
      last_collection_status: null,
      last_collection_error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
  }

  function installMetricDetailFetch(interval: string) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/metrics/metric-1/series')) {
        return mockJsonResponse({
          metric_id: 'metric-1',
          scan_config_id: null,
          interval,
          latest_signal: null,
          // Two same-day points: they collapse into one daily bucket only when
          // the effective granularity is 'day'.
          data: [
            metricSeriesPoint('2026-01-02T05:00:00Z', 10),
            metricSeriesPoint('2026-01-02T18:00:00Z', 20),
          ],
        })
      }
      if (url.includes('/api/v1/projects/demo/metrics/metric-1/breakdowns')) {
        return mockJsonResponse({
          metric_id: 'metric-1',
          scan_config_id: null,
          interval,
          columns: [],
          selected_column: null,
          series: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/metrics/metric-1')) {
        return mockJsonResponse(metricDefinitionResponse(interval))
      }
      if (url.includes('/api/v1/projects/demo/annotations')) return mockJsonResponse([])

      throw new Error(`Unhandled fetch: ${url}`)
    })
  }

  function renderMetricDetail() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/monitoring/metric/metric-1']}>
          <Routes>
            <Route path="/p/:slug/monitoring/:scope/:id" element={<MonitoringDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('defaults granularity to the metric interval for 1d metrics (tripl-4m86)', async () => {
    installMetricDetailFetch('1d')
    renderMetricDetail()

    const chart = await screen.findByTestId('metrics-chart')
    await waitFor(() => expect(chart).toHaveAttribute('data-points', '1'))
    expect(chart).toHaveAttribute('data-first-bucket', '2026-01-02T00:00:00.000Z')
  })

  it('keeps the hourly default for sub-daily metrics', async () => {
    installMetricDetailFetch('1h')
    renderMetricDetail()

    const chart = await screen.findByTestId('metrics-chart')
    await waitFor(() => expect(chart).toHaveAttribute('data-points', '2'))
  })
})
