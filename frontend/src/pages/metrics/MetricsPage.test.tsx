import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DataSource,
  FactTableListItem,
  FactTableListResponse,
  MetricDefinitionListItem,
  MetricDefinitionListResponse,
} from '@/types'
import MetricsPage, { type MetricsTab } from './MetricsPage'

vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: { list: vi.fn() },
}))
vi.mock('@/api/factTablesApi', () => ({
  factTablesApi: { list: vi.fn() },
}))
vi.mock('@/api/dataSources', () => ({
  dataSourcesApi: { list: vi.fn() },
}))

import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { factTablesApi } from '@/api/factTablesApi'
import { dataSourcesApi } from '@/api/dataSources'

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

function makeFactTable(overrides: Partial<FactTableListItem>): FactTableListItem {
  return {
    id: 'ft-1',
    project_id: 'p-1',
    name: 'orders',
    display_name: 'Orders',
    description: '',
    color: '#6366f1',
    order: 0,
    data_source_id: 'ds-1',
    timestamp_column: 'created_at',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
    ...overrides,
  }
}

function mockList(body: MetricDefinitionListResponse) {
  vi.mocked(metricsCatalogApi.list).mockResolvedValue(body)
}

function mockFactTables(body: FactTableListResponse) {
  vi.mocked(factTablesApi.list).mockResolvedValue(body)
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

function renderMetrics(tab: MetricsTab = 'catalog') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const path = tab === 'fact-tables' ? '/p/demo/metrics/fact-tables' : '/p/demo/metrics'
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:slug/metrics" element={<MetricsPage tab="catalog" />} />
          <Route path="/p/:slug/metrics/fact-tables" element={<MetricsPage tab="fact-tables" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(metricsCatalogApi.list).mockReset()
  vi.mocked(factTablesApi.list).mockReset()
  vi.mocked(dataSourcesApi.list).mockReset()
  vi.mocked(dataSourcesApi.list).mockResolvedValue([
    { id: 'ds-1', name: 'Warehouse' },
  ] as unknown as DataSource[])
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

  it('renders both Catalog and Fact tables tabs as deep-linkable routes', async () => {
    mockList({ items: [], total: 0 })

    renderMetrics()

    const catalogTab = await screen.findByRole('tab', { name: 'Catalog' })
    const factTablesTab = screen.getByRole('tab', { name: 'Fact tables' })
    expect(catalogTab).toHaveAttribute('href', '/p/demo/metrics')
    expect(factTablesTab).toHaveAttribute('href', '/p/demo/metrics/fact-tables')
    // On the Catalog route, the Catalog tab is the selected one.
    expect(catalogTab).toHaveAttribute('aria-selected', 'true')
    expect(factTablesTab).toHaveAttribute('aria-selected', 'false')
  })

  it('shows the New metric action on the Catalog tab', async () => {
    mockList({ items: [makeItem({ id: 'm-1' })], total: 1 })

    renderMetrics()

    const links = await screen.findAllByRole('link', { name: /New metric/ })
    expect(links[0]).toHaveAttribute('href', '/p/demo/metrics/new')
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

  describe('Fact tables tab', () => {
    it('keeps the Metrics heading and lists fact tables on the Fact tables tab', async () => {
      mockFactTables({
        items: [makeFactTable({ id: 'ft-1', display_name: 'Orders', timestamp_column: 'created_at' })],
        total: 1,
      })

      renderMetrics('fact-tables')

      // Same page chrome (H1 "Metrics", area "Observe"), Fact tables tab selected.
      expect(await screen.findByRole('heading', { name: 'Metrics' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Fact tables' })).toHaveAttribute(
        'aria-selected',
        'true',
      )

      const cell = await screen.findByText('Orders')
      const row = cell.closest('[role="row"]') as HTMLElement
      expect(row).not.toBeNull()
      expect(within(row).getByText('created_at')).toBeInTheDocument()
      // Row edit link points at the fact-tables tab edit route.
      const link = within(row).getByRole('link', { name: 'Orders' })
      expect(link).toHaveAttribute('href', '/p/demo/metrics/fact-tables/ft-1/edit')
    })

    it('shows the contextual New fact table action on the Fact tables tab', async () => {
      mockFactTables({ items: [], total: 0 })

      renderMetrics('fact-tables')

      const links = await screen.findAllByRole('link', { name: /New fact table/ })
      expect(links[0]).toHaveAttribute('href', '/p/demo/metrics/fact-tables/new')
    })
  })
})
