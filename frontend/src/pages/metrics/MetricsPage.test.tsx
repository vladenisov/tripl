import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetricDefinitionListItem, MetricDefinitionListResponse } from '@/types'
import MetricsPage from './MetricsPage'

vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: { list: vi.fn() },
}))

import { metricsCatalogApi } from '@/api/metricsCatalogApi'

function makeItem(overrides: Partial<MetricDefinitionListItem>): MetricDefinitionListItem {
  return {
    id: 'm-1',
    project_id: 'p-1',
    name: 'checkout_conversion',
    display_name: 'Checkout conversion',
    description: '',
    kind: 'sql',
    status: 'active',
    aggregation: null,
    composition: null,
    interval: '1h',
    color: '#6366f1',
    unit: '%',
    anomaly_detection_enabled: true,
    reviewed: false,
    owner_id: null,
    order: 0,
    spark: [1, 2, 3, 4, 5],
    latest_value: 42,
    latest_bucket: null,
    latest_signal: null,
    last_collected_at: null,
    last_collection_status: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
    ...overrides,
  }
}

function mockList(body: MetricDefinitionListResponse) {
  vi.mocked(metricsCatalogApi.list).mockResolvedValue(body)
}

// The row only reads `state` + `direction`; a minimal shape keeps the test
// focused (mirrors the existing `as unknown as` casts above).
function makeSignal(
  state: string,
  direction: 'spike' | 'drop' = 'spike',
): NonNullable<MetricDefinitionListItem['latest_signal']> {
  return { state, direction } as unknown as NonNullable<
    MetricDefinitionListItem['latest_signal']
  >
}

function renderMetrics() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/metrics']}>
        <Routes>
          <Route path="/p/:slug/metrics" element={<MetricsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(metricsCatalogApi.list).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MetricsPage', () => {
  it('renders the rollup and a metric row from the mocked api', async () => {
    mockList({
      items: [makeItem({ id: 'm-1', display_name: 'Checkout conversion', kind: 'sql', latest_value: 42 })],
      total: 1,
    })

    renderMetrics()

    expect(await screen.findByRole('heading', { name: 'Metrics' })).toBeInTheDocument()
    const cell = await screen.findByText('Checkout conversion')
    // Scope kind/status assertions to the row — those labels also appear in the
    // filter <select> options and the rollup MiniStats.
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(within(row).getByText('SQL')).toBeInTheDocument()
    expect(within(row).getByText('42 %')).toBeInTheDocument()
    expect(within(row).getByText('Active')).toBeInTheDocument()
  })

  it('links each metric row to its monitoring drilldown route', async () => {
    mockList({ items: [makeItem({ id: 'abc-123', display_name: 'Revenue' })], total: 1 })

    renderMetrics()

    const link = await screen.findByRole('link', { name: 'Revenue' })
    expect(link).toHaveAttribute('href', '/p/demo/monitoring/metric/abc-123')
  })

  it('shows active-anomaly visuals for a latest-scan signal', async () => {
    mockList({
      items: [
        makeItem({
          id: 'm-firing',
          display_name: 'Firing metric',
          latest_signal: makeSignal('latest_scan', 'spike'),
        }),
      ],
      total: 1,
    })

    renderMetrics()

    const cell = await screen.findByText('Firing metric')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    // Pulsing dot + sparkline anomaly marker on the latest (current) point.
    expect(row.querySelector('.pulse-dot')).not.toBeNull()
    expect(row.querySelector('circle')).not.toBeNull()
  })

  it('suppresses active-anomaly visuals for a recent (already-cleared) signal', async () => {
    mockList({
      items: [
        makeItem({
          id: 'm-recent',
          display_name: 'Recent metric',
          latest_signal: makeSignal('recent', 'spike'),
        }),
      ],
      total: 1,
    })

    renderMetrics()

    const cell = await screen.findByText('Recent metric')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    // The most recent scan was clean: no pulse, no anomaly marker.
    expect(row.querySelector('.pulse-dot')).toBeNull()
    expect(row.querySelector('circle')).toBeNull()
  })

  it('shows an empty state with a create CTA when the catalog is empty', async () => {
    mockList({ items: [], total: 0 })

    renderMetrics()

    expect(await screen.findByText('No metrics yet')).toBeInTheDocument()
    const links = await screen.findAllByRole('link', { name: /New metric/ })
    expect(links[0]).toHaveAttribute('href', '/p/demo/metrics/new')
  })
})
