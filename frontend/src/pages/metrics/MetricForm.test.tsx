import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, EventListItem, MetricDefinitionResponse } from '@/types'
import { MetricForm } from './MetricForm'

vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: {
    create: vi.fn().mockResolvedValue({ id: 'created' }),
    update: vi.fn().mockResolvedValue({ id: 'updated' }),
  },
}))

vi.mock('@/api/factTablesApi', () => ({
  factTablesApi: {
    list: vi.fn(),
    get: vi.fn(),
  },
}))

import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { factTablesApi } from '@/api/factTablesApi'

const DATA_SOURCES = [
  { id: 'ds-1', name: 'Warehouse' },
] as unknown as DataSource[]

const EVENTS = [
  { id: 'ev-1', name: 'checkout:start' },
  { id: 'ev-2', name: 'checkout:done' },
] as unknown as EventListItem[]

const FACT_TABLES = {
  total: 2,
  items: [
    { id: 'ft-1', display_name: 'Orders', name: 'orders' },
    { id: 'ft-2', display_name: 'Sessions', name: 'sessions' },
  ],
}

const FACT_TABLE_DETAIL = {
  id: 'ft-1',
  name: 'orders',
  display_name: 'Orders',
  columns: [
    { name: 'amount', type: 'numeric' },
    { name: 'user_id', type: 'text' },
  ],
  identifier_columns: ['user_id'],
  row_filters: [{ name: 'completed', sql: 'status = $1' }],
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children)
}

function renderForm(metric: MetricDefinitionResponse | null = null) {
  const onClose = vi.fn()
  render(
    createElement(MetricForm, {
      slug: 'demo',
      metric,
      dataSources: DATA_SOURCES,
      events: EVENTS,
      onClose,
    }),
    { wrapper },
  )
  return { onClose }
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /Create metric|Save metric/ }))
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(metricsCatalogApi.create).mockClear()
  vi.mocked(metricsCatalogApi.update).mockClear()
  vi.mocked(factTablesApi.list).mockReset()
  vi.mocked(factTablesApi.get).mockReset()
  vi.mocked(factTablesApi.list).mockResolvedValue(
    FACT_TABLES as unknown as Awaited<ReturnType<typeof factTablesApi.list>>,
  )
  vi.mocked(factTablesApi.get).mockResolvedValue(
    FACT_TABLE_DETAIL as unknown as Awaited<ReturnType<typeof factTablesApi.get>>,
  )
})

afterEach(() => {
  queryClient.clear()
})

describe('MetricForm validation', () => {
  it('rejects a SQL metric that is missing required identity/config', async () => {
    renderForm()

    // Fresh form: kind defaults to SQL, with no display name, data source, or query.
    submit()

    expect(await screen.findByText('Display name is required.')).toBeInTheDocument()
    expect(screen.getByText('A data source is required for a SQL metric.')).toBeInTheDocument()
    expect(screen.getByText('The metric SQL query is required.')).toBeInTheDocument()
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
  })

  it('requires a time column for a SQL metric', async () => {
    renderForm()

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Total revenue' },
    })
    fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
      target: { value: 'total_revenue' },
    })
    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    fireEvent.change(document.getElementById('metric-sql-query')!, {
      target: { value: 'SELECT 1 AS value' },
    })

    submit()

    expect(
      await screen.findByText('A time column is required for a SQL metric.'),
    ).toBeInTheDocument()
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
  })

  it('creates a valid SQL metric', async () => {
    const { onClose } = renderForm()

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Order count' },
    })
    fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
      target: { value: 'order_count' },
    })
    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    fireEvent.change(document.getElementById('metric-sql-query')!, {
      target: { value: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1' },
    })
    fireEvent.change(document.getElementById('metric-sql-time')!, { target: { value: 'bucket' } })

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'sql',
        data_source_id: 'ds-1',
        name: 'order_count',
        display_name: 'Order count',
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  // A saved metric whose `config` is intentionally empty: in create mode that
  // would fail the "metric SQL query is required" check. It must not block an
  // edit, since config is immutable and excluded from the update.
  const EDIT_METRIC = {
    id: 'metric-1',
    project_id: 'p-1',
    kind: 'sql',
    name: 'order_count',
    display_name: 'Order count',
    description: 'Orders per hour',
    status: 'active',
    unit: null,
    color: '#6366f1',
    anomaly_detection_enabled: true,
    breakdown_columns: [],
    app_version_column: null,
    platform_column: null,
    data_source_id: 'ds-1',
    interval: '1h',
    aggregation: 'count',
    composition: null,
    numerator_event_id: null,
    denominator_event_id: null,
    reviewed: false,
    order: 0,
    config: {},
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
  } as unknown as MetricDefinitionResponse

  it('hides immutable identity/config and renders the internal name read-only in edit mode', () => {
    renderForm(EDIT_METRIC)

    expect(screen.getByRole('heading', { name: 'Edit metric' })).toBeInTheDocument()
    // Internal name is shown as text, not an editable input.
    expect(screen.queryByLabelText('Internal name', { exact: false })).toBeNull()
    expect(document.getElementById('metric-name')).toBeNull()
    expect(screen.getByText('order_count')).toBeInTheDocument()
    // The kind-specific config section is not rendered at all.
    expect(document.getElementById('metric-sql-data-source')).toBeNull()
    expect(document.getElementById('metric-sql-query')).toBeNull()
    expect(document.getElementById('metric-sql-time')).toBeNull()
  })

  it('saves presentation edits without re-validating immutable config', async () => {
    const { onClose } = renderForm(EDIT_METRIC)

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Orders / hour' },
    })

    submit()

    await waitFor(() => expect(metricsCatalogApi.update).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.update).toHaveBeenCalledWith(
      'demo',
      'metric-1',
      expect.objectContaining({ display_name: 'Orders / hour' }),
    )
    // The empty config would fail create-mode validation; it must not block an edit.
    expect(screen.queryByText('The metric SQL query is required.')).toBeNull()
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('still requires a display name when editing', async () => {
    renderForm(EDIT_METRIC)

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: '   ' },
    })

    submit()

    expect(await screen.findByText('Display name is required.')).toBeInTheDocument()
    expect(metricsCatalogApi.update).not.toHaveBeenCalled()
  })

  it('requires a denominator for a ratio event_composition, then accepts one', async () => {
    renderForm()

    // Switch to event composition.
    fireEvent.click(screen.getByRole('radio', { name: /Event composition/ }))
    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Checkout ratio' },
    })
    fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
      target: { value: 'checkout_ratio' },
    })
    fireEvent.change(document.getElementById('metric-composition')!, { target: { value: 'ratio' } })
    fireEvent.change(document.getElementById('metric-numerator')!, { target: { value: 'ev-2' } })

    submit()

    expect(
      await screen.findByText('A denominator event is required for a ratio metric.'),
    ).toBeInTheDocument()
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()

    // Provide the denominator and resubmit.
    fireEvent.change(document.getElementById('metric-denominator')!, { target: { value: 'ev-1' } })
    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'event_composition',
        composition: 'ratio',
        numerator_event_id: 'ev-2',
        denominator_event_id: 'ev-1',
      }),
    )
  })

  function fillFactIdentity(displayName: string, name: string) {
    fireEvent.click(screen.getByRole('radio', { name: /Fact/ }))
    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: displayName },
    })
    fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
      target: { value: name },
    })
  }

  it('builds a single fact metric with a sum over a measure column', async () => {
    renderForm()
    fillFactIdentity('Total revenue', 'total_revenue')

    // Pick the fact table once the list (and its options) has loaded; its detail
    // (columns) then loads asynchronously.
    await waitFor(() =>
      expect(document.querySelector('#metric-fact-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })
    await waitFor(() => expect(factTablesApi.get).toHaveBeenCalledWith('demo', 'ft-1'))

    // Sum requires a measure column; the dropdown appears and fills from columns.
    fireEvent.change(document.getElementById('metric-fact-aggregation')!, { target: { value: 'sum' } })
    await waitFor(() =>
      expect(document.querySelector('#metric-fact-measure option[value="amount"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-measure')!, { target: { value: 'amount' } })

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'fact',
        composition: 'single',
        fact_table_id: 'ft-1',
        aggregation: 'sum',
        measure_column: 'amount',
        distinct_column: null,
        row_filter: null,
      }),
    )
  })

  it('rejects a sum fact metric with no measure column', async () => {
    renderForm()
    fillFactIdentity('Total revenue', 'total_revenue')

    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })
    fireEvent.change(document.getElementById('metric-fact-aggregation')!, { target: { value: 'sum' } })

    submit()

    expect(
      await screen.findByText('A measure column is required for the sum aggregation.'),
    ).toBeInTheDocument()
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
  })

  it('builds a ratio fact metric with numerator and denominator operands', async () => {
    renderForm()
    fillFactIdentity('Revenue per session', 'revenue_per_session')

    fireEvent.change(document.getElementById('metric-fact-composition')!, { target: { value: 'ratio' } })

    // Both operands use count, so no measure/distinct column is required.
    await waitFor(() =>
      expect(document.querySelector('#metric-fact-num-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-num-table')!, { target: { value: 'ft-1' } })
    fireEvent.change(document.getElementById('metric-fact-den-table')!, { target: { value: 'ft-2' } })

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'fact',
        composition: 'ratio',
        numerator: expect.objectContaining({ fact_table_id: 'ft-1', aggregation: 'count' }),
        denominator: expect.objectContaining({ fact_table_id: 'ft-2', aggregation: 'count' }),
      }),
    )
  })
})
