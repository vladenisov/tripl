import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EventMetricPoint } from '@/types'
import MonitoringDetailPage from './MonitoringDetailPage'

vi.mock('@/components/ui/chart-lazy', () => ({
  MetricsChart: ({
    data,
    forecast,
    valueFormatter,
  }: {
    data?: Array<{ bucket: string }>
    forecast?: unknown[]
    valueFormatter?: (value: number) => string
  }) => (
    <div
      data-testid="metrics-chart"
      data-forecast-count={forecast?.length ?? 0}
      data-points={data?.length ?? 0}
      data-first-bucket={data?.[0]?.bucket ?? ''}
      // Probe the optional formatter: percent metrics turn 0.08 into '8%'.
      data-value-sample={valueFormatter ? valueFormatter(0.08) : ''}
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
      { version: '2.10.0', is_other: false, is_latest: true, is_active: true },
      { version: '2.9.0', is_other: false, is_latest: false, is_active: true },
      { version: 'Other', is_other: true, is_latest: false, is_active: false },
    ],
    series: [
      {
        version: '2.10.0',
        is_other: false,
        is_latest: true,
        is_active: true,
        total_count: 120,
        data: [metricPoint('2026-01-02T00:00:00Z', 120)],
      },
      {
        version: '2.9.0',
        is_other: false,
        is_latest: false,
        is_active: true,
        total_count: 80,
        data: [metricPoint('2026-01-02T00:00:00Z', 80)],
      },
      {
        version: 'Other',
        is_other: true,
        is_latest: false,
        is_active: false,
        total_count: 10,
        data: [metricPoint('2026-01-02T00:00:00Z', 10)],
      },
    ],
  }
}

// Same shape, but the SemVer-newest release (2.10.0) has NOT taken a real share
// of traffic yet (is_active=false): the backend still reports it as is_latest via
// the raw-SemVer-max fallback, so the page must treat it as a pre-release rather
// than the primary rolled-out "latest".
function appVersionPreReleaseResponse(scanConfigId: string) {
  return {
    ...appVersionResponse(scanConfigId),
    versions: [
      { version: '2.10.0', is_other: false, is_latest: true, is_active: false },
      { version: '2.9.0', is_other: false, is_latest: false, is_active: true },
      { version: 'Other', is_other: true, is_latest: false, is_active: false },
    ],
    series: [
      {
        version: '2.10.0',
        is_other: false,
        is_latest: true,
        is_active: false,
        total_count: 4,
        data: [metricPoint('2026-01-02T00:00:00Z', 4)],
      },
      {
        version: '2.9.0',
        is_other: false,
        is_latest: false,
        is_active: true,
        total_count: 180,
        data: [metricPoint('2026-01-02T00:00:00Z', 180)],
      },
      {
        version: 'Other',
        is_other: true,
        is_latest: false,
        is_active: false,
        total_count: 10,
        data: [metricPoint('2026-01-02T00:00:00Z', 10)],
      },
    ],
  }
}

function appVersionPreReleaseAdoptionResponse(scanConfigId: string) {
  return {
    ...appVersionPreReleaseResponse(scanConfigId),
    totals: [{ bucket: '2026-01-02T00:00:00Z', count: 194 }],
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

  it('treats a non-active SemVer-newest version as a pre-release, not the primary latest', async () => {
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
          data: [metricPoint('2026-01-02T00:00:00Z', 194)],
          forecast: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1')) {
        return mockJsonResponse({ id: 'scan-1', app_version_column: 'app_version' })
      }
      if (url.includes('/api/v1/projects/demo/annotations')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/scans/scan-1/app-versions')) {
        return mockJsonResponse(appVersionPreReleaseResponse('scan-1'))
      }
      if (url.includes('/api/v1/projects/demo/scans/scan-1/version-adoption')) {
        return mockJsonResponse(appVersionPreReleaseAdoptionResponse('scan-1'))
      }
      if (url.includes('/api/v1/projects/demo/scans/scan-1/release-regressions')) {
        return mockJsonResponse({
          scan_config_id: 'scan-1',
          app_version_column: 'app_version',
          latest_version: '2.9.0',
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

    // Header badge reads "pre-release 2.10.0", NOT the primary "latest 2.10.0".
    expect(await screen.findByText('pre-release 2.10.0')).toBeInTheDocument()
    expect(screen.queryByText('latest 2.10.0')).not.toBeInTheDocument()

    // The chart series labels the newest release "· pre-release" rather than "· latest".
    await waitFor(() => {
      const charts = screen.getAllByTestId('multi-chart')
      expect(charts[0]).toHaveAttribute('data-labels', '2.10.0 · pre-release|2.9.0|Other')
    })

    // The Latest filter carries a warning affordance (pre-release / low traffic).
    expect(screen.getByRole('button', { name: 'Latest' })).toHaveAttribute(
      'title',
      'The newest release is a pre-release with little traffic — not yet rolled out.',
    )
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

describe('MonitoringDetailPage volume granularity follows range (tripl-7l83.10)', () => {
  // Radix Select drives selection through pointer capture, which jsdom omits.
  beforeAll(() => {
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {}
    }
  })

  // Three project-total points that bucket to distinct counts per granularity:
  //   hour -> 3 buckets, day -> 2 (the two 2026-01-01 points merge),
  //   week -> 1 (all three land in the epoch-anchored 2026-01-01 week).
  function installProjectTotalFetch() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
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
          data: [
            metricPoint('2026-01-01T05:00:00Z', 5),
            metricPoint('2026-01-01T18:00:00Z', 7),
            metricPoint('2026-01-02T10:00:00Z', 3),
          ],
          forecast: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/scans/scan-1')) {
        return mockJsonResponse({ id: 'scan-1', app_version_column: null })
      }
      if (url.includes('/api/v1/projects/demo/annotations')) return mockJsonResponse([])

      throw new Error(`Unhandled fetch: ${url}`)
    })
  }

  // Each range change refetches (no placeholderData) and remounts the chart, so
  // always re-query the testid rather than holding a stale node reference.
  const chartPoints = () => screen.getByTestId('metrics-chart').getAttribute('data-points')

  it('defaults granularity to the selected range (30d -> days, 90d -> weeks, 7d -> hours)', async () => {
    installProjectTotalFetch()
    renderMonitoringPage()

    await screen.findByTestId('metrics-chart')
    // 30d default: daily buckets, so the two 2026-01-01 points collapse.
    await waitFor(() => expect(chartPoints()).toBe('2'))

    // 90d: weekly buckets, all three points collapse into one.
    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    await waitFor(() => expect(chartPoints()).toBe('1'))

    // 7d: hourly buckets, every point is its own bucket.
    fireEvent.click(screen.getByRole('button', { name: '7d' }))
    await waitFor(() => expect(chartPoints()).toBe('3'))
  })

  it('keeps a manual granularity override sticky across range changes', async () => {
    installProjectTotalFetch()
    renderMonitoringPage()

    await screen.findByTestId('metrics-chart')
    await waitFor(() => expect(chartPoints()).toBe('2'))

    // Manually override to Hours.
    fireEvent.click(screen.getByRole('combobox', { name: /time granularity/i }))
    fireEvent.click(await screen.findByRole('option', { name: 'Hours' }))
    await waitFor(() => expect(chartPoints()).toBe('3'))

    // Changing the range must NOT reset the override back to a range default:
    // 90d would default to weekly (1 point), but the sticky override keeps 3.
    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    await waitFor(() => expect(chartPoints()).toBe('3'))
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

  function metricDefinitionResponse(
    interval: string | null,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      ...metricDefinitionBase(interval),
      ...overrides,
    }
  }

  function metricDefinitionBase(interval: string | null) {
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

  function metricAnnotationFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ann-1',
      project_id: 'p-1',
      scope_type: 'metric',
      scope_ref: 'metric-1',
      bucket: '2026-01-02T00:00:00Z',
      label: 'v2.0 release',
      description: null,
      color: '#ef4444',
      created_by_user_id: null,
      created_at: '2026-01-01T00:00:00Z',
      ...overrides,
    }
  }

  function installMetricDetailFetch(
    interval: string,
    definitionOverrides: Record<string, unknown> = {},
    seriesOverrides: Record<string, unknown> = {},
    annotations: Array<Record<string, unknown>> = [],
  ) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      // Events list backing the Definition card's event-name resolution.
      if (url.endsWith('/api/v1/projects/demo/events')) {
        return mockJsonResponse({
          items: [
            { id: 'event-a', name: 'checkout_completed' },
            { id: 'event-b', name: 'session_started' },
          ],
          total: 2,
        })
      }
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
          ...seriesOverrides,
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
        return mockJsonResponse(metricDefinitionResponse(interval, definitionOverrides))
      }
      if (url.includes('/api/v1/projects/demo/annotations')) {
        if (init?.method === 'POST') {
          const posted = JSON.parse(String(init.body)) as Record<string, unknown>
          return new Response(JSON.stringify(metricAnnotationFixture(posted)), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return mockJsonResponse(annotations)
      }

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

  it('renders percent-unit metrics ×100 in the stat card and chart formatter (tripl-nxk2.1)', async () => {
    installMetricDetailFetch(
      '1d',
      { unit: '%' },
      {
        latest_signal: {
          scan_config_id: null,
          scope_type: 'metric',
          scope_ref: 'metric-1',
          state: 'latest_scan',
          event_id: null,
          event_type_id: null,
          bucket: '2026-01-02T00:00:00Z',
          actual_count: 0.08,
          expected_count: 0.05,
          stddev: 0.01,
          z_score: 3,
          direction: 'spike',
        },
      },
    )
    renderMetricDetail()

    const chart = await screen.findByTestId('metrics-chart')
    // The percent-aware formatter reached the chart: 0.08 → '8%'.
    expect(chart).toHaveAttribute('data-value-sample', '8%')
    // The latest-signal stat card renders the stored fractions ×100.
    expect(screen.getByText('8 %')).toBeInTheDocument()
    expect(screen.getByText('5 %')).toBeInTheDocument()
  })

  it('passes no value formatter for metrics without a percent unit', async () => {
    installMetricDetailFetch('1d')
    renderMetricDetail()

    const chart = await screen.findByTestId('metrics-chart')
    expect(chart).toHaveAttribute('data-value-sample', '')
  })

  it('labels the primary tab and card "Value" for the metric scope, not "Volume"', async () => {
    installMetricDetailFetch('1d')
    renderMetricDetail()

    await screen.findByTestId('metrics-chart')
    // Catalog metrics (ratios/averages) are values, not volumes.
    expect(screen.getByRole('tab', { name: 'Value' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Value' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Volume' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Volume' })).not.toBeInTheDocument()
  })

  it('renders the Annotations card with metric-scope annotations (tripl-nxk2.13)', async () => {
    installMetricDetailFetch('1d', {}, {}, [metricAnnotationFixture()])
    renderMetricDetail()

    await screen.findByTestId('metrics-chart')
    expect(screen.getByRole('heading', { name: 'Annotations' })).toBeInTheDocument()
    expect(await screen.findByText('v2.0 release')).toBeInTheDocument()
    expect(screen.getByText('(1)')).toBeInTheDocument()
  })

  it('creates a metric-scope annotation with scope_type metric and the metric id', async () => {
    const fetchSpy = installMetricDetailFetch('1d')
    renderMetricDetail()

    await screen.findByTestId('metrics-chart')
    fireEvent.change(screen.getByLabelText('Date and time'), {
      target: { value: '2026-01-02T10:00' },
    })
    fireEvent.change(screen.getByPlaceholderText('Label (e.g. v1.4 deploy)'), {
      target: { value: 'campaign launch' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([callUrl, callInit]) =>
          String(callUrl).includes('/api/v1/projects/demo/annotations')
          && callInit?.method === 'POST',
      )
      expect(postCall).toBeDefined()
      const body = JSON.parse(String(postCall![1]?.body)) as Record<string, unknown>
      expect(body.scope_type).toBe('metric')
      expect(body.scope_ref).toBe('metric-1')
      expect(body.label).toBe('campaign launch')
    })
  })

  it('coaches the metric-scope Breakdowns empty state with an Edit metric link', async () => {
    installMetricDetailFetch('1d')
    renderMetricDetail()

    await screen.findByTestId('metrics-chart')

    const breakdownsTab = screen.getByRole('tab', { name: /Breakdowns/i })
    fireEvent.pointerDown(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.mouseDown(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.mouseUp(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.click(breakdownsTab)

    // Metric-scope copy — no "event"/"scan" language, points at the metric settings.
    expect(
      await screen.findByText(/Add breakdown columns in the metric settings/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Edit metric/i })).toBeInTheDocument()
    // Event-scope copy must not leak into the metric scope.
    expect(
      screen.queryByText(/Edit this event and add a column/i),
    ).not.toBeInTheDocument()
  })

  it('renders the Definition card for a SQL metric with collapsed SQL that expands', async () => {
    installMetricDetailFetch('1d', {
      config: {
        metric_sql: 'SELECT day, dau FROM daily_users',
        time_column: 'day',
        value_column: 'dau',
      },
    })
    renderMetricDetail()

    expect(await screen.findByRole('heading', { name: 'Definition' })).toBeInTheDocument()
    // Kind chip + collection-interval meta chip.
    expect(screen.getByText('SQL')).toBeInTheDocument()
    expect(screen.getByText('every 1d')).toBeInTheDocument()
    // Time/value column chips from the SQL config.
    expect(screen.getByText('day')).toBeInTheDocument()
    expect(screen.getByText('dau')).toBeInTheDocument()

    // The SQL itself is collapsed behind a "Show SQL" disclosure by default…
    const sql = screen.getByText('SELECT day, dau FROM daily_users')
    expect(sql).not.toBeVisible()
    // …and expands on click.
    fireEvent.click(screen.getByText('Show SQL'))
    expect(sql).toBeVisible()
  })

  it('renders an event-composition ratio as "A ÷ B" with resolved event names', async () => {
    installMetricDetailFetch('1d', {
      kind: 'event_composition',
      composition: 'ratio',
      numerator_event_id: 'event-a',
      denominator_event_id: 'event-b',
    })
    renderMetricDetail()

    expect(await screen.findByRole('heading', { name: 'Definition' })).toBeInTheDocument()
    expect(screen.getByText('Event composition')).toBeInTheDocument()
    // Event ids resolve to names via the events list; joined by ÷.
    expect(await screen.findByText('checkout_completed')).toBeInTheDocument()
    expect(screen.getByText('session_started')).toBeInTheDocument()
    expect(screen.getByText('÷')).toBeInTheDocument()
  })

  it('does not render the Definition card outside the metric scope', async () => {
    installEventDetailFetch()
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    expect(screen.queryByRole('heading', { name: 'Definition' })).not.toBeInTheDocument()
    expect(screen.queryByText('Show SQL')).not.toBeInTheDocument()
  })
})
