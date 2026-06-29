import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, FactTableListItem, FactTableListResponse } from '@/types'
import FactTablesPage from './FactTablesPage'

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

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/fact-tables']}>
        <Routes>
          <Route path="/p/:slug/fact-tables" element={<FactTablesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
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

describe('FactTablesPage', () => {
  it('renders a fact table row with its source and timestamp column', async () => {
    mockList({
      items: [makeItem({ id: 'ft-1', display_name: 'Orders', timestamp_column: 'created_at' })],
      total: 1,
    })

    renderPage()

    expect(await screen.findByRole('heading', { name: 'Fact tables' })).toBeInTheDocument()
    const cell = await screen.findByText('Orders')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(within(row).getByText('orders')).toBeInTheDocument()
    expect(within(row).getByText('Warehouse')).toBeInTheDocument()
    expect(within(row).getByText('created_at')).toBeInTheDocument()
  })

  it('links each row to its edit route', async () => {
    mockList({ items: [makeItem({ id: 'abc-123', display_name: 'Sessions' })], total: 1 })

    renderPage()

    const link = await screen.findByRole('link', { name: 'Sessions' })
    expect(link).toHaveAttribute('href', '/p/demo/fact-tables/abc-123/edit')
  })

  it('shows an empty state with a create CTA when there are no fact tables', async () => {
    mockList({ items: [], total: 0 })

    renderPage()

    expect(await screen.findByText('No fact tables yet')).toBeInTheDocument()
    const links = await screen.findAllByRole('link', { name: /New fact table/ })
    expect(links[0]).toHaveAttribute('href', '/p/demo/fact-tables/new')
  })
})
