import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, FactTableListItem, FactTableListResponse } from '@/types'
import { FactTablesList } from './FactTablesList'

vi.mock('@/api/factTablesApi', () => ({
  factTablesApi: { list: vi.fn() },
}))
vi.mock('@/api/dataSources', () => ({
  dataSourcesApi: { list: vi.fn() },
}))

import { factTablesApi } from '@/api/factTablesApi'
import { dataSourcesApi } from '@/api/dataSources'

function makeItem(overrides: Partial<FactTableListItem>): FactTableListItem {
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

function mockList(body: FactTableListResponse) {
  vi.mocked(factTablesApi.list).mockResolvedValue(body)
}

// Mount the list body the same way the Fact tables tab does: inside a project
// route that supplies the :slug param.
function renderList() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/metrics/fact-tables']}>
        <Routes>
          <Route path="/p/:slug/metrics/fact-tables" element={<FactTablesListHarness />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Tiny harness that reads :slug from the route and feeds it to the list, since
// FactTablesList now takes slug as a prop (the parent MetricsPage resolves it).
function FactTablesListHarness() {
  return <FactTablesList slug="demo" />
}

beforeEach(() => {
  vi.mocked(factTablesApi.list).mockReset()
  vi.mocked(dataSourcesApi.list).mockReset()
  vi.mocked(dataSourcesApi.list).mockResolvedValue([
    { id: 'ds-1', name: 'Warehouse' },
  ] as unknown as DataSource[])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FactTablesList', () => {
  it('renders a fact table row with its source and timestamp column', async () => {
    mockList({
      items: [makeItem({ id: 'ft-1', display_name: 'Orders', timestamp_column: 'created_at' })],
      total: 1,
    })

    renderList()

    const cell = await screen.findByText('Orders')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(within(row).getByText('orders')).toBeInTheDocument()
    expect(within(row).getByText('Warehouse')).toBeInTheDocument()
    expect(within(row).getByText('created_at')).toBeInTheDocument()
  })

  it('titles the list panel for what it lists, not for the tab next to it', async () => {
    mockList({ items: [makeItem({})], total: 1 })

    renderList()

    const table = await screen.findByRole('table', { name: 'Fact tables' })
    const panel = table.closest('section') as HTMLElement
    expect(panel).not.toBeNull()
    const header = panel.querySelector('header') as HTMLElement
    expect(header).not.toBeNull()
    // The header used to read "Catalog / 1 total": the same hardcoded title as
    // the panel on the Catalog tab (tripl-p4kr). Only the title was wrong. The
    // "N total" caption is the shape both tabs' list panels share, and dropping
    // it here left Fact tables the one bare header on the page (tripl-9jzt).
    expect(header.textContent).toBe('Fact tables1 total')
    expect(screen.queryByText('Catalog')).toBeNull()
  })

  // The count is the server's `total`, not `items.length`: a truncated first
  // page would otherwise caption the panel with the page size.
  it('captions the panel with the server total, not the row count', async () => {
    mockList({ items: [makeItem({ id: 'ft-1' })], total: 12 })

    renderList()

    const table = await screen.findByRole('table', { name: 'Fact tables' })
    const header = (table.closest('section') as HTMLElement).querySelector('header') as HTMLElement
    expect(header.textContent).toBe('Fact tables12 total')
  })

  it('links each row to its edit route under Metrics', async () => {
    mockList({ items: [makeItem({ id: 'abc-123', display_name: 'Sessions' })], total: 1 })

    renderList()

    const link = await screen.findByRole('link', { name: 'Sessions' })
    expect(link).toHaveAttribute('href', '/p/demo/metrics/fact-tables/abc-123/edit')
  })

  it('shows an empty state with a create CTA pointing under Metrics', async () => {
    mockList({ items: [], total: 0 })

    renderList()

    expect(await screen.findByText('No fact tables yet')).toBeInTheDocument()
    const links = await screen.findAllByRole('link', { name: /New fact table/ })
    expect(links[0]).toHaveAttribute('href', '/p/demo/metrics/fact-tables/new')
  })
})
