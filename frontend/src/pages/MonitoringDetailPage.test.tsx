import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventMetricPoint } from '@/types'
import MonitoringDetailPage from './MonitoringDetailPage'

vi.mock('@/components/ui/chart-lazy', () => ({
  MetricsChart: () => <div data-testid="metrics-chart" />,
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
