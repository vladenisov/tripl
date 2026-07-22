import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetricDefinitionListResponse, MonitoringSignal } from '@/types'
import AnomaliesPage from './AnomaliesPage'

vi.mock('@/api/metrics', () => ({
  metricsApi: { getActiveSignals: vi.fn() },
}))
vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: { list: vi.fn() },
}))

import { metricsApi } from '@/api/metrics'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'

function makeSignal(overrides: Partial<MonitoringSignal>): MonitoringSignal {
  return {
    scan_config_id: 'scan-1',
    scope_type: 'metric',
    scope_ref: '9136d575-0000-4000-8000-000000000001',
    state: 'latest_scan',
    event_id: null,
    event_type_id: null,
    bucket: '2026-07-01T00:00:00Z',
    actual_count: 120,
    expected_count: 80,
    stddev: 5,
    z_score: 8,
    direction: 'spike',
    incident_child: false,
    ...overrides,
  }
}

// Only `id` + `display_name` feed the id → name map; the cast keeps the mock
// minimal (mirrors the `as unknown as` style of MetricsPage.test.tsx).
function makeCatalogResponse(
  items: Array<{ id: string; display_name: string }>,
): MetricDefinitionListResponse {
  return { items, total: items.length } as unknown as MetricDefinitionListResponse
}

/** Probe target for the metric drilldown route the row should navigate to. */
function MetricDetailProbe() {
  const { metricId } = useParams<{ metricId: string }>()
  return <div>metric-detail:{metricId}</div>
}

function renderAnomalies() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/anomalies']}>
        <Routes>
          <Route path="/p/:slug/anomalies" element={<AnomaliesPage />} />
          <Route path="/p/:slug/monitoring/metric/:metricId" element={<MetricDetailProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(metricsApi.getActiveSignals).mockReset()
  vi.mocked(metricsCatalogApi.list).mockReset()
  vi.mocked(metricsCatalogApi.list).mockResolvedValue(makeCatalogResponse([]))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnomaliesPage — metric-scope signals (tripl-nxk2.4)', () => {
  it('renders a metric signal with its resolved catalog name and links to the metric drilldown', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_ref: 'metric-abc' }),
    ])
    vi.mocked(metricsCatalogApi.list).mockResolvedValue(
      makeCatalogResponse([{ id: 'metric-abc', display_name: 'Checkout conversion' }]),
    )

    renderAnomalies()

    // Label resolves via the catalog map: "Metric · <display name>".
    const cell = await screen.findByText('Spike on Metric · Checkout conversion')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    // Linkable rows are keyboard-focusable and navigate on click.
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.click(row)
    expect(await screen.findByText('metric-detail:metric-abc')).toBeInTheDocument()
  })

  it('falls back to the short scope ref when the metric id is unknown to the catalog', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_ref: '9136d575-0000-4000-8000-000000000001', direction: 'drop' }),
    ])
    // Catalog resolves but no longer contains the definition (e.g. deleted).
    vi.mocked(metricsCatalogApi.list).mockResolvedValue(makeCatalogResponse([]))

    renderAnomalies()

    // Fallback label: "Metric <first 8 of ref>" — still linked to the drilldown.
    const cell = await screen.findByText('Drop on Metric 9136d575')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.click(row)
    expect(
      await screen.findByText('metric-detail:9136d575-0000-4000-8000-000000000001'),
    ).toBeInTheDocument()
  })

  it('keeps non-metric scope labels unchanged', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'project_total', scope_ref: 'pt-1' }),
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-12345678' }),
    ])

    renderAnomalies()

    expect(await screen.findByText('Spike on Project total')).toBeInTheDocument()
    expect(screen.getByText('Spike on Event type et-12345')).toBeInTheDocument()
  })

  it('tags incident children folded under a project_total spike, but not the parent', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'project_total', scope_ref: 'pt-1', incident_child: false }),
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-12345678', incident_child: true }),
    ])

    renderAnomalies()

    // Both scopes are listed (no collapse), and only the child carries the tag.
    const parentRow = (await screen.findByText('Spike on Project total')).closest(
      '[role="row"]',
    ) as HTMLElement
    const childRow = screen
      .getByText('Spike on Event type et-12345')
      .closest('[role="row"]') as HTMLElement
    expect(childRow).toHaveTextContent('part of total')
    expect(parentRow).not.toHaveTextContent('part of total')
  })
})
