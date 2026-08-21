import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { EventMetricPoint, Project } from '@/types'
import { DemoScenarioProvider } from '@/demo/DemoScenarioProvider'
import {
  buildChapterSteps,
  initialScenarioState,
  readScenarioState,
  writeScenarioState,
  type ScenarioState,
} from '@/demo/scenarioModel'
import { liveLoopState } from '@/demo/scenarioTestState'
import MonitoringDetailPage from './MonitoringDetailPage'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
  Toaster: () => null,
}))

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
    seriesLabel,
    valueFormatter,
  }: {
    series: Array<{ label: string }>
    emptyLabel?: string
    seriesLabel?: string
    valueFormatter?: (value: number) => string
  }) => (
    <div
      data-testid="multi-chart"
      data-labels={series.map(item => item.label).join('|')}
      data-series-label={seriesLabel ?? ''}
      // Probe the optional formatter: percent metrics turn 0.08 into '8%'.
      data-value-sample={valueFormatter ? valueFormatter(0.08) : ''}
    >
      {series.length ? series.map(item => <span key={item.label}>{item.label}</span>) : emptyLabel}
    </div>
  ),
}))

vi.mock('@/components/sql-editor', () => ({
  SqlEditor: ({
    ariaLabel,
    value,
    readOnly,
  }: {
    ariaLabel?: string
    value: string
    readOnly?: boolean
  }) => <textarea aria-label={ariaLabel} value={value} readOnly={readOnly} onChange={() => {}} />,
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
  function installProjectTotalFetch(
    forecast: Array<{ bucket: string; expected_count: number; stddev: number }> = [],
  ) {
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
          forecast,
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
  const chartForecastCount = () => screen.getByTestId('metrics-chart').getAttribute('data-forecast-count')

  it('defaults to 7d hours and follows later range changes', async () => {
    const fetchSpy = installProjectTotalFetch()
    renderMonitoringPage()

    await screen.findByTestId('metrics-chart')
    // Initial 7d default: hourly buckets, so every point stays distinct.
    await waitFor(() => expect(chartPoints()).toBe('3'))
    const initialMetricsUrl = fetchSpy.mock.calls
      .map(([input]) => String(input))
      .find(url => url.includes('/api/v1/projects/demo/metrics/total'))
    expect(initialMetricsUrl).toBeDefined()
    const initialRange = new URL(initialMetricsUrl!, 'http://localhost').searchParams
    const initialFrom = new Date(initialRange.get('from')!).getTime()
    const initialTo = new Date(initialRange.get('to')!).getTime()
    expect(initialTo - initialFrom).toBe(7 * 24 * 60 * 60 * 1000)

    // 30d: daily buckets, so the two 2026-01-01 points collapse.
    fireEvent.click(screen.getByRole('button', { name: '30d' }))
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
    await waitFor(() => expect(chartPoints()).toBe('3'))

    // Manually override the 7d hourly default to Days.
    fireEvent.click(screen.getByRole('combobox', { name: /time granularity/i }))
    fireEvent.click(await screen.findByRole('option', { name: 'Days' }))
    await waitFor(() => expect(chartPoints()).toBe('2'))

    // Changing the range must NOT reset the override back to a range default:
    // 90d would default to weekly (1 point), but the sticky override keeps 2.
    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    await waitFor(() => expect(chartPoints()).toBe('2'))
  })

  it('only renders a forecast at the native collection granularity', async () => {
    installProjectTotalFetch([
      {
        bucket: '2026-01-02T11:00:00Z',
        expected_count: 4,
        stddev: 1,
      },
    ])
    renderMonitoringPage()

    await screen.findByTestId('metrics-chart')
    // The 7d default keeps native hourly buckets and their one-hour forecast.
    await waitFor(() => expect(chartForecastCount()).toBe('1'))

    // The 30d preset rolls hourly actuals into days. A one-hour forecast is not
    // a forecast for the whole day and must not be appended to that series.
    fireEvent.click(screen.getByRole('button', { name: '30d' }))
    await waitFor(() => expect(chartForecastCount()).toBe('0'))

    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    await waitFor(() => expect(chartForecastCount()).toBe('0'))

    fireEvent.click(screen.getByRole('combobox', { name: /time granularity/i }))
    fireEvent.click(await screen.findByRole('option', { name: 'Hours' }))
    await waitFor(() => expect(chartForecastCount()).toBe('1'))
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

describe('MonitoringDetailPage back affordance (tripl-lkox)', () => {
  function installProjectTotalOnlyFetch() {
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
          data: [metricPoint('2026-01-01T05:00:00Z', 5)],
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

  it('names Anomalies on a project-total drilldown, the area it is reached from', async () => {
    // navigation.ts assigns /monitoring/project-total/ (and /monitoring/
    // event-type/) to Anomalies, and the breadcrumb above the button says so.
    // The label branched on `metric` alone, so the only navigation affordance
    // above the fold offered "Back to events" — somewhere the reader had not
    // been.
    installProjectTotalOnlyFetch()
    renderMonitoringPage()

    expect(await screen.findByRole('button', { name: /back to anomalies/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /back to events/i })).toBeNull()
  })
})

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
  opts: {
    metricsData?: EventMetricPoint[]
    event?: Record<string, unknown>
    breakdowns?: Record<string, unknown>
    latestSignal?: Record<string, unknown> | null
  } = {},
) {
  const metricsData = opts.metricsData ?? [metricPoint('2026-01-02T00:00:00Z', 200)]
  const latestSignal = opts.latestSignal ?? null
  const event = opts.event ?? eventFixture()
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url.endsWith('/api/v1/projects/demo/event-types')) {
      return mockJsonResponse([eventTypeFixture()])
    }
    if (url.endsWith('/api/v1/projects/demo/meta-fields')) return mockJsonResponse([])
    if (url.endsWith('/api/v1/projects/demo/variables')) return mockJsonResponse([])
    if (url.includes('/api/v1/projects/demo/events/event-1/history')) return mockJsonResponse([])
    if (url.includes('/api/v1/projects/demo/events/event-1/metrics/breakdowns')) {
      return mockJsonResponse(opts.breakdowns ?? {
        event_id: 'event-1',
        scan_config_id: 'scan-1',
        interval: '1h',
        columns: [],
        selected_column: null,
        series: [],
      })
    }
    if (url.includes('/api/v1/projects/demo/events/event-1/metrics')) {
      return mockJsonResponse({
        scope: 'event',
        scan_config_id: 'scan-1',
        event_id: 'event-1',
        event_type_id: 'type-1',
        interval: '1h',
        latest_signal: latestSignal,
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

// A drop that bottomed out at zero: the detector clamps such z-scores to a
// constant magnitude (here -20), so the banner must read the outcome
// ("dropped to zero") rather than the uninformative number.
function dropToZeroSignal(): Record<string, unknown> {
  return {
    scan_config_id: 'scan-1',
    scope_type: 'event',
    scope_ref: 'event-1',
    state: 'recent',
    event_id: 'event-1',
    event_type_id: null,
    bucket: '2026-01-02T00:00:00Z',
    actual_count: 0,
    expected_count: 120,
    stddev: 6,
    z_score: -20,
    direction: 'drop',
  }
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

  it('surfaces an inline volume-vs-baseline mini-chart beside the signal banner (tripl-yfsj.11)', async () => {
    installEventDetailFetch({
      latestSignal: dropToZeroSignal(),
      metricsData: [
        metricPoint('2026-01-01T00:00:00Z', 120),
        {
          ...metricPoint('2026-01-02T00:00:00Z', 0),
          is_anomaly: true,
          anomaly_direction: 'drop',
          expected_count: 120,
          stddev: 6,
          z_score: -20,
        },
      ],
    })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    // The claim in the banner ("vs. baseline") is now visible in context: a
    // compact chart sits in the hero, not only behind the Metrics tab, and it
    // reuses the already-fetched series (both points reach it).
    const miniChart = within(await screen.findByTestId('signal-volume-chart'))
      .getByTestId('metrics-chart')
    expect(miniChart).toHaveAttribute('data-points', '2')
  })

  it('names the baseline instead of titling a chart that cannot draw one (tripl-v2lm)', async () => {
    // expected_count/stddev are persisted only on FLAGGED buckets, so the
    // dashed expectation has a single non-null point and paints nothing. The
    // panel was titled "Volume vs. baseline" above one bare series — the
    // comparison that justifies the alert, promised and then not shown.
    installEventDetailFetch({
      latestSignal: {
        scan_config_id: 'scan-1',
        scope_type: 'event',
        scope_ref: 'event-1',
        state: 'recent',
        event_id: 'event-1',
        event_type_id: null,
        bucket: '2026-01-02T00:00:00Z',
        actual_count: 8_400,
        expected_count: 2_915,
        stddev: 140,
        z_score: 39.6,
        direction: 'spike',
      },
    })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    const panel = within(await screen.findByTestId('signal-volume-chart'))
    expect(panel.getByText('Volume')).toBeInTheDocument()
    expect(panel.queryByText(/vs\. baseline/i)).toBeNull()
    // Locale-safe: the page groups through toLocaleString, like every other count.
    expect(
      panel.getByText(`baseline ${(2915).toLocaleString()} at the flagged bucket`),
    ).toBeInTheDocument()
  })

  it('keeps a sub-unit baseline readable instead of rounding it to the no-baseline case', async () => {
    // `expected_count` is a mean of prior buckets, so a rare event's baseline is
    // legitimately below 1. The caption's `> 0` gate admits it and then
    // `Math.round` printed "baseline 0" — the caption contradicting the gate
    // that had just decided a baseline existed, on the same page whose signal
    // card already formats this value-aware.
    installEventDetailFetch({
      latestSignal: { ...dropToZeroSignal(), expected_count: 0.4, z_score: -6.2 },
    })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    const panel = within(await screen.findByTestId('signal-volume-chart'))
    expect(
      panel.getByText(`baseline ${(0.4).toLocaleString()} at the flagged bucket`),
    ).toBeInTheDocument()
    expect(panel.queryByText(/baseline 0 at the flagged bucket/)).toBeNull()
  })

  it('omits the signal mini-chart when the event has no active anomaly', async () => {
    installEventDetailFetch() // latest_signal defaults to null → no banner, no chart
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    expect(screen.queryByTestId('signal-volume-chart')).not.toBeInTheDocument()
  })

  it('reads "dropped to zero" instead of a clamped z-score when a drop bottoms out (tripl-yfsj.9)', async () => {
    installEventDetailFetch({ latestSignal: dropToZeroSignal() })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    const banner = screen.getByText(/Volume drop detected/)
    expect(banner.textContent).toContain('dropped to zero')
    // The uninformative clamped magnitude (z=-20.0) is suppressed in the banner.
    expect(banner.textContent).not.toMatch(/z\s*=/)
  })

  it('names a zero baseline in the banner rather than dropping the clause (tripl-l429.27)', async () => {
    // An event firing where nothing was expected. The "vs. baseline" clause used
    // to be omitted silently, so the banner was quietly shorter on exactly the
    // signals that moved the most and a reader could not tell whether the
    // comparison was missing or undefined.
    installEventDetailFetch({
      latestSignal: {
        ...dropToZeroSignal(),
        direction: 'spike',
        actual_count: 137,
        expected_count: 0,
        stddev: 1,
        z_score: 9.1,
      },
    })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    const banner = screen.getByText(/Volume spike detected/)
    expect(banner.textContent).toContain('no baseline to compare against')
    // Never the undefined ratio written as a number.
    expect(banner.textContent).not.toContain('vs. baseline')
    expect(banner.textContent).not.toMatch(/[+-]?\d+% vs/)
  })

  it('keeps the numeric z-score in the banner for a partial (non-zero) drop', async () => {
    installEventDetailFetch({
      latestSignal: {
        ...dropToZeroSignal(),
        actual_count: 81,
        expected_count: 100,
        stddev: 6,
        z_score: -3.3,
      },
    })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    const banner = screen.getByText(/Volume drop detected/)
    expect(banner.textContent).toContain('z=-3.3')
    expect(banner.textContent).not.toContain('dropped to zero')
  })

  it('shows platform share anomalies separately from breakdown volume series', async () => {
    installEventDetailFetch({
      breakdowns: {
        event_id: 'event-1',
        scan_config_id: 'scan-1',
        interval: '1h',
        columns: ['platform'],
        selected_column: 'platform',
        series: [
          {
            breakdown_value: 'ios',
            is_other: false,
            total_count: 60,
            data: [metricPoint('2026-01-02T00:00:00Z', 10)],
            parity_anomalies: [
              {
                bucket: '2026-01-02T00:00:00Z',
                actual_share: 0.1,
                expected_share: 0.5,
                stddev: 0.02,
                z_score: -20,
                direction: 'drop',
              },
            ],
          },
        ],
      },
    })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    const breakdownsTab = screen.getByRole('tab', { name: /Breakdowns/i })
    fireEvent.pointerDown(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.mouseDown(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.mouseUp(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.click(breakdownsTab)

    expect(await screen.findByText('platform share anomalies')).toBeInTheDocument()
    expect(screen.getByLabelText('ios share drop: 50.0% -> 10.0%')).toBeInTheDocument()

    // Event-scope breakdowns keep today's rendering exactly: the 'events'
    // label and NO value formatter (tripl-4dej regression guard).
    const chart = screen.getByTestId('multi-chart')
    expect(chart).toHaveAttribute('data-series-label', 'events')
    expect(chart).toHaveAttribute('data-value-sample', '')
  })

  it('filters breakdown series to the selected values (tripl-egt5)', async () => {
    const point = metricPoint('2026-01-02T00:00:00Z', 10)
    installEventDetailFetch({
      breakdowns: {
        event_id: 'event-1',
        scan_config_id: 'scan-1',
        interval: '1h',
        columns: ['platform'],
        selected_column: 'platform',
        series: [
          { breakdown_value: 'ios', is_other: false, total_count: 60, data: [point], parity_anomalies: [] },
          { breakdown_value: 'android', is_other: false, total_count: 40, data: [point], parity_anomalies: [] },
          { breakdown_value: 'web', is_other: false, total_count: 20, data: [point], parity_anomalies: [] },
        ],
      },
    })
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    const breakdownsTab = screen.getByRole('tab', { name: /Breakdowns/i })
    fireEvent.pointerDown(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.mouseDown(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.mouseUp(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.click(breakdownsTab)

    // Default: every value renders.
    const chart = await screen.findByTestId('multi-chart')
    expect(chart).toHaveAttribute('data-labels', 'ios|android|web')

    // Picking one value isolates its series…
    fireEvent.click(screen.getByRole('button', { name: 'Toggle android' }))
    await waitFor(() =>
      expect(screen.getByTestId('multi-chart')).toHaveAttribute('data-labels', 'android'))
    expect(screen.getByRole('button', { name: 'Toggle android' }))
      .toHaveAttribute('aria-pressed', 'true')

    // …picking a second adds it (response order preserved)…
    fireEvent.click(screen.getByRole('button', { name: 'Toggle web' }))
    await waitFor(() =>
      expect(screen.getByTestId('multi-chart')).toHaveAttribute('data-labels', 'android|web'))

    // …and "Show all" resets to the full set.
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    await waitFor(() =>
      expect(screen.getByTestId('multi-chart')).toHaveAttribute('data-labels', 'ios|android|web'))
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
    breakdownsOverrides: Record<string, unknown> = {},
    versionsOverrides: Record<string, unknown> = {},
    settledCollectionStatus: 'success' | 'error' | null = null,
  ) {
    let collectStarted = false
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
      if (url.endsWith('/api/v1/projects/demo/fact-tables')) {
        return mockJsonResponse({
          items: [
            {
              id: 'ft-1',
              project_id: 'p-1',
              name: 'orders',
              display_name: 'Orders',
              description: '',
              color: '#6366f1',
              order: 0,
              data_source_id: null,
              timestamp_column: 'created_at',
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
            },
          ],
          total: 1,
        })
      }
      if (url.endsWith('/api/v1/projects/demo/fact-tables/ft-1')) {
        return mockJsonResponse({
          id: 'ft-1',
          project_id: 'p-1',
          name: 'orders',
          display_name: 'Orders',
          description: '',
          color: '#6366f1',
          order: 0,
          data_source_id: null,
          timestamp_column: 'created_at',
          sql: 'SELECT * FROM orders',
          columns: [{ name: 'created_at', type: 'timestamp' }],
          identifier_columns: [],
          row_filters: [],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
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
          ...breakdownsOverrides,
        })
      }
      if (url.includes('/api/v1/projects/demo/metrics/metric-1/versions')) {
        return mockJsonResponse({
          metric_id: 'metric-1',
          scan_config_id: null,
          app_version_column: 'app_version',
          interval,
          latest_version: '2.0.0',
          versions: [
            { version: '2.0.0', is_other: false, is_latest: true, is_active: true },
          ],
          series: [
            {
              version: '2.0.0',
              is_other: false,
              is_latest: true,
              is_active: true,
              total_value: 0.3,
              data: [
                metricSeriesPoint('2026-01-01T00:00:00Z', 0.1),
                metricSeriesPoint('2026-01-02T00:00:00Z', 0.2),
              ],
            },
          ],
          ...versionsOverrides,
        })
      }
      // Manual "Collect now" — the POST the scenario's collect step hangs on.
      if (url.endsWith('/api/v1/projects/demo/metrics/metric-1/collect')) {
        collectStarted = true
        return mockJsonResponse({
          metric_id: 'metric-1',
          status: 'queued',
          window_from: null,
          window_to: null,
          task_id: 'task-1',
          // The batch is capped, so a click reports the size it actually got.
          metric_count: 3,
        })
      }
      if (url.endsWith('/api/v1/projects/demo/metrics/metric-1')) {
        return mockJsonResponse(metricDefinitionResponse(interval, {
          ...definitionOverrides,
          ...(collectStarted && settledCollectionStatus
            ? { last_collection_status: settledCollectionStatus }
            : {}),
        }))
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
    const result = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/monitoring/metric/metric-1']}>
          <Routes>
            <Route path="/p/:slug/monitoring/:scope/:id" element={<MonitoringDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return { ...result, queryClient }
  }

  it('keeps the 30d range and defaults granularity to the interval for 1d metrics (tripl-4m86)', async () => {
    const fetchSpy = installMetricDetailFetch('1d')
    renderMetricDetail()

    const chart = await screen.findByTestId('metrics-chart')
    await waitFor(() => expect(chart).toHaveAttribute('data-points', '1'))
    expect(chart).toHaveAttribute('data-first-bucket', '2026-01-02T00:00:00.000Z')
    const seriesUrl = fetchSpy.mock.calls
      .map(([input]) => String(input))
      .find(url => url.includes('/api/v1/projects/demo/metrics/metric-1/series'))
    expect(seriesUrl).toBeDefined()
    const range = new URL(seriesUrl!, 'http://localhost').searchParams
    const from = new Date(range.get('from')!).getTime()
    const to = new Date(range.get('to')!).getTime()
    expect(to - from).toBe(30 * 24 * 60 * 60 * 1000)
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

  it('renders percent-metric breakdowns with the percent formatter and unit label (tripl-4dej)', async () => {
    installMetricDetailFetch(
      '1d',
      { unit: '%' },
      {},
      [],
      {
        columns: ['platform'],
        selected_column: 'platform',
        series: [
          {
            breakdown_value: 'ios',
            is_other: false,
            total_value: 0.4,
            data: [metricSeriesPoint('2026-01-02T00:00:00Z', 0.08)],
          },
          {
            breakdown_value: 'android',
            is_other: false,
            total_value: 0.3,
            data: [metricSeriesPoint('2026-01-02T00:00:00Z', 0.05)],
          },
        ],
      },
    )
    renderMetricDetail()

    await screen.findByTestId('metrics-chart')
    const breakdownsTab = screen.getByRole('tab', { name: /Breakdowns/i })
    fireEvent.pointerDown(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.mouseDown(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.mouseUp(breakdownsTab, { button: 0, ctrlKey: false })
    fireEvent.click(breakdownsTab)

    const chart = await screen.findByTestId('multi-chart')
    expect(chart).toHaveAttribute('data-labels', 'ios|android')
    // The percent-aware formatter reached the breakdown chart (0.08 → '8%'),
    // and the tooltip label is the metric's unit — never 'events'.
    expect(chart).toHaveAttribute('data-value-sample', '8%')
    expect(chart).toHaveAttribute('data-series-label', '%')
  })

  it('shows the latest ratio value in the version legend instead of a summed total', async () => {
    installMetricDetailFetch('1d', {
      unit: '%',
      kind: 'fact',
      composition: 'ratio',
      app_version_column: 'app_version',
    })
    renderMetricDetail()

    await screen.findByTestId('metrics-chart')
    const byVersionTab = screen.getByRole('tab', { name: /By version/i })
    fireEvent.pointerDown(byVersionTab, { button: 0, ctrlKey: false })
    fireEvent.mouseDown(byVersionTab, { button: 0, ctrlKey: false })
    fireEvent.pointerUp(byVersionTab, { button: 0, ctrlKey: false })
    fireEvent.mouseUp(byVersionTab, { button: 0, ctrlKey: false })
    fireEvent.click(byVersionTab)

    expect(await screen.findByText('latest value: 20%')).toBeInTheDocument()
    expect(screen.queryByText('30%')).not.toBeInTheDocument()
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
    const sql = screen.getByDisplayValue('SELECT day, dau FROM daily_users')
    expect(sql).not.toBeVisible()
    // …and expands on click.
    fireEvent.click(screen.getByText('Show SQL'))
    expect(sql).toBeVisible()
    expect(sql).toHaveAttribute('readonly')
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

  it('explains that collecting a fact metric refreshes all dependents in one batch', async () => {
    const fetchSpy = installMetricDetailFetch('1d', {
      kind: 'fact',
      composition: 'single',
      aggregation: 'count',
      fact_table_id: 'ft-1',
    })
    renderMetricDetail()

    const button = await screen.findByRole('button', { name: 'Refresh source metrics' })
    expect(button.getAttribute('title')).toMatch(
      /current warehouse data.*all dependent active metrics.*one batch/i,
    )
    fireEvent.click(button)

    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/api/v1/projects/demo/metrics/metric-1/collect')
          && init?.method === 'POST',
      )).toBe(true)
    })
    expect(screen.getByRole('button', { name: 'Refreshing source metrics…' })).toBeDisabled()
  })

  it('reports how many metrics the fact batch actually refreshes', async () => {
    // The batch is capped, so "all dependent metrics" could promise more than the
    // click started. The response says how many it got; the toast repeats it.
    toastSuccess.mockClear()
    installMetricDetailFetch('1d', {
      kind: 'fact',
      composition: 'single',
      aggregation: 'count',
      fact_table_id: 'ft-1',
    })
    renderMetricDetail()

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh source metrics' }))

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining('3 metrics'))
    })
  })

  it('refreshes every metric-series cache after a fact batch completes', async () => {
    installMetricDetailFetch(
      '1d',
      {
        kind: 'fact',
        composition: 'single',
        aggregation: 'count',
        fact_table_id: 'ft-1',
      },
      {},
      [],
      {},
      {},
      'success',
    )
    const { queryClient } = renderMetricDetail()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    fireEvent.click(await screen.findByRole('button', { name: 'Refresh source metrics' }))

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['monitoringMetrics', 'demo', 'metric'],
      })
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['metricDefinition', 'demo', 'metric-1'],
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['metrics-catalog', 'demo'] })
  })

  it('does not render the Definition card outside the metric scope', async () => {
    installEventDetailFetch()
    renderEventDetail()
    await screen.findByRole('heading', { name: 'checkout_completed' })

    expect(screen.queryByRole('heading', { name: 'Definition' })).not.toBeInTheDocument()
    expect(screen.queryByText('Show SQL')).not.toBeInTheDocument()
  })

  /**
   * The coached demo scenario (tripl-2su6.21.5). Rendered inside the REAL
   * provider: the persisted state is the only honest witness that the collect
   * the USER fired — not one of the demo tick's own — bound the scenario.
   */
  describe('coached demo scenario', () => {
    const SLUG = 'demo'
    const POLL_MS = 10
    const STEPS = buildChapterSteps(SLUG, 'live-loop', initialScenarioState())
    const COLLECT_INSTRUCTION = STEPS[2].instruction

    function demoProject(overrides: Partial<Project> = {}): Project {
      return {
        id: 'p-1',
        name: 'Demo',
        slug: SLUG,
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
        is_demo: true,
        generation_status: 'ready',
        ...overrides,
      } as Project
    }

    function collectMetricState(): ScenarioState {
      return liveLoopState('live-loop/collect-metric', {
        scan: { scanConfigId: 'sc-1', scanJobId: 'job-1', startedAt: Date.now() },
      })
    }

    function renderWithScenario(project: Project) {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      return render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/p/demo/monitoring/metric/metric-1']}>
            <DemoScenarioProvider project={project} pollIntervalMs={POLL_MS}>
              <Routes>
                <Route path="/p/:slug/monitoring/:scope/:id" element={<MonitoringDetailPage />} />
              </Routes>
            </DemoScenarioProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    }

    const callouts = () => document.querySelectorAll('[data-slot="popover-content"]')
    const collectButton = async () => {
      const button = await screen.findByRole('button', { name: /Collect now/ })
      await waitFor(() => expect(button).toBeEnabled())
      return button
    }

    afterEach(() => {
      window.localStorage.clear()
    })

    it('binds the scenario to this metric when the collect is accepted', async () => {
      writeScenarioState(SLUG, collectMetricState())
      // The definition never settles, so the step stays put for the assertion.
      installMetricDetailFetch('1d')
      renderWithScenario(demoProject())

      fireEvent.click(await collectButton())

      await waitFor(() => expect(readScenarioState(SLUG).chapters['live-loop']?.artifacts?.metricId).toBe('metric-1'))
    })

    it('marks Collect now while the collect step is the active one', async () => {
      writeScenarioState(SLUG, collectMetricState())
      installMetricDetailFetch('1d')
      renderWithScenario(demoProject())

      await collectButton()
      await waitFor(() => expect(screen.getAllByText(COLLECT_INSTRUCTION)).toHaveLength(1))
    })

    it('leaves a project that is not a demo untouched', async () => {
      writeScenarioState(SLUG, collectMetricState())
      installMetricDetailFetch('1d')
      renderWithScenario(demoProject({ is_demo: false }))

      fireEvent.click(await collectButton())

      // The collect still runs; the notify is inert and no mark is mounted.
      await waitFor(() => expect(screen.getByText('Collecting…')).toBeInTheDocument())
      expect(readScenarioState(SLUG).chapters['live-loop']?.artifacts?.metricId).toBeUndefined()
      expect(callouts()).toHaveLength(0)
      expect(screen.queryByText(COLLECT_INSTRUCTION)).not.toBeInTheDocument()
    })
  })
})
